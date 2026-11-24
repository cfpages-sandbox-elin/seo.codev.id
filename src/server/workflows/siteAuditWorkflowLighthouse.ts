import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  failedLighthouseFetch,
  fetchLighthouseResult,
  selectLighthouseSample,
  storeLighthouseResult,
} from "@/server/lib/audit/lighthouse";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import type { AuditConfig } from "@/server/lib/audit/types";
import { pgStep } from "@/server/workflows/pgStep";
import {
  DB_STEP,
  LIGHTHOUSE_FETCH_STEP,
  LIGHTHOUSE_PERSIST_STEP,
} from "@/server/workflows/auditStepConfigs";

/**
 * URLs fetched concurrently per wave. Each URL runs mobile + desktop, so one
 * wave holds up to 10 paid DataForSEO calls in flight; the aux worker's parse
 * lock serializes the memory-heavy payload parsing behind them.
 */
const LIGHTHOUSE_URL_CONCURRENCY = 5;

export type LighthousePhaseParams = {
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
};

export async function runLighthousePhase(
  step: WorkflowStep,
  params: LighthousePhaseParams,
) {
  const {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
  } = params;
  if (config.lighthouseStrategy === "none") return;

  const lighthouseWork = await selectLighthousePages({
    step,
    auditId,
    workflowInstanceId,
    startUrl,
    strategy: config.lighthouseStrategy,
  });

  let completedChecks = 0;
  let failedChecks = 0;
  for (
    let chunkStart = 0;
    chunkStart < lighthouseWork.length;
    chunkStart += LIGHTHOUSE_URL_CONCURRENCY
  ) {
    const chunk = lighthouseWork.slice(
      chunkStart,
      chunkStart + LIGHTHOUSE_URL_CONCURRENCY,
    );

    // The paid calls are checkpointed separately from all storage. With
    // Workflow retries disabled, a later R2/DB/progress failure cannot replay
    // DataForSEO. One URL groups its mobile + desktop checks into one compact
    // checkpoint. allSettled, not all: a rejected step must not orphan the
    // sibling paid calls mid-flight — their checkpoints complete and persist
    // below either way.
    const settled = await Promise.allSettled(
      chunk.map(({ url, pageId }, chunkOffset) =>
        pgStep(
          step,
          `lighthouse-fetch-${chunkStart + chunkOffset + 1}`,
          LIGHTHOUSE_FETCH_STEP,
          () =>
            Promise.all([
              fetchLighthouseResult(url, pageId, "mobile", billingCustomer),
              fetchLighthouseResult(url, pageId, "desktop", billingCustomer),
            ]),
        ),
      ),
    );
    const fetched = settled.flatMap((outcome, chunkOffset) => {
      if (outcome.status === "fulfilled") return outcome.value;
      // Step timeout or engine failure — provider errors never reject here
      // (the audit-layer fetch converts them into errorMessage results).
      const { url, pageId } = chunk[chunkOffset];
      const message =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      return (["mobile", "desktop"] as const).map((strategy) =>
        failedLighthouseFetch(url, pageId, strategy, message),
      );
    });

    const chunkIndex = Math.floor(chunkStart / LIGHTHOUSE_URL_CONCURRENCY) + 1;
    const priorCompleted = completedChecks;
    const priorFailed = failedChecks;
    const counts = await pgStep(
      step,
      `lighthouse-persist-chunk-${chunkIndex}`,
      LIGHTHOUSE_PERSIST_STEP,
      async () => {
        const results = await Promise.all(
          fetched.map((result) =>
            storeLighthouseResult({
              projectId,
              auditId,
              fetched: result,
            }),
          ),
        );
        await AuditRepository.insertLighthouseResults(auditId, results);

        const failed = results.filter((result) => result.errorMessage).length;
        const completed = results.length - failed;
        await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
          lighthouseCompleted: priorCompleted + completed,
          lighthouseFailed: priorFailed + failed,
        });
        return { completed, failed };
      },
    );

    completedChecks += counts.completed;
    failedChecks += counts.failed;
  }
}

async function selectLighthousePages(params: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  startUrl: string;
  strategy: AuditConfig["lighthouseStrategy"];
}) {
  const { step, auditId, workflowInstanceId, startUrl, strategy } = params;
  return pgStep(step, "select-lighthouse-sample", DB_STEP, async () => {
    // Crawled pages come from the DB — the crawl phase no longer holds a
    // whole-crawl page list in memory.
    const crawledPages = await AuditRepository.getPagesForAudit(auditId);
    const sample = selectLighthouseSample(
      crawledPages.map((page) => ({
        ...page,
        statusCode: page.statusCode ?? 0,
      })),
      startUrl,
      strategy,
    );
    const selectedUrls = new Set(sample);

    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "lighthouse",
      lighthouseTotal: sample.length * 2,
      lighthouseCompleted: 0,
      lighthouseFailed: 0,
    });
    return crawledPages.flatMap((page) =>
      selectedUrls.has(page.url) ? [{ url: page.url, pageId: page.id }] : [],
    );
  });
}
