import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { discoverUrls, parseRobotsTxt } from "@/server/lib/audit/discovery";
import { runLighthousePhase } from "@/server/workflows/siteAuditWorkflowLighthouse";
import {
  getOrigin,
  isSameOrigin,
  normalizeUrl,
} from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getAuditScratchpad } from "@/server/features/audit/AuditScratchpad";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import type { DetectedIssue } from "@/server/lib/audit/issues/page-reporters";
import type { AuditConfig } from "@/server/lib/audit/types";
import type { CrawlerAccess } from "@/shared/crawler-access";
import type { RenderUsage } from "@/shared/audit-rendering";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  runCrawlPhase,
  type CrawlPhaseResult,
} from "@/server/workflows/siteAuditWorkflowCrawl";
import { pgStep } from "@/server/workflows/pgStep";
import {
  DB_STEP,
  DISCOVERY_STEP,
  MULTIPAGE_CHECKS_STEP,
} from "@/server/workflows/auditStepConfigs";

/** Frontier seeds per scratchpad RPC call. */
const SEED_RPC_BATCH = 2_000;

type AuditPhasesParams = {
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  access?: CrawlerAccess | null;
  renderUsage: RenderUsage;
};

export async function runAuditPhases(
  step: WorkflowStep,
  params: AuditPhasesParams,
) {
  const {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    access,
    renderUsage,
  } = params;
  const origin = getOrigin(startUrl);
  const maxPages = config.maxPages;

  const discovery = await runDiscoveryPhase(step, {
    auditId,
    workflowInstanceId,
    origin,
    startUrl,
    maxPages,
    access,
  });
  // Parsed outside the step from checkpointed text, so replays see the exact
  // robots rules the original run used (a live re-fetch could differ and
  // desync the frontier from already-persisted crawl batches).
  const robots = parseRobotsTxt(origin, discovery.robotsText);
  const crawl = await runCrawlPhase(step, {
    auditId,
    workflowInstanceId,
    origin,
    maxPages,
    robots,
    seededCount: discovery.seededCount,
    renderJavaScript: config.renderJavaScript,
    renderUsage,
    access,
  });
  await runLighthousePhase(step, {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
  });
  await finalizeAudit({
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
  });
}

async function runDiscoveryPhase(
  step: WorkflowStep,
  input: {
    auditId: string;
    workflowInstanceId: string;
    origin: string;
    startUrl: string;
    maxPages: number;
    access?: CrawlerAccess | null;
  },
) {
  const { auditId, workflowInstanceId, origin, startUrl, maxPages, access } =
    input;
  // "-v2": the checkpoint shape changed (seeds now live in the scratchpad DO
  // instead of the step return). A pre-refactor instance replayed under this
  // code must re-run discovery — resuming from the old cached {sitemapUrls}
  // shape would leave the scratchpad empty and finalize a zero-page audit.
  return pgStep(step, "discover-urls-v2", DISCOVERY_STEP, async () => {
    const result = await discoverUrls(origin, maxPages, access);
    const robots = parseRobotsTxt(origin, result.robotsText);
    const scratchpad = getAuditScratchpad(auditId);

    // Seeds go straight into the scratchpad frontier — nothing large is
    // returned as step state (an uncapped seed list used to blow the ~1MiB
    // step-output limit on big sitemaps).
    let seededCount = 0;
    const normalizedStart = normalizeUrl(startUrl) ?? startUrl;
    if (
      robots.isAllowed(normalizedStart) &&
      isSameOrigin(normalizedStart, origin)
    ) {
      await scratchpad.seedStart(normalizedStart);
      seededCount += 1;
    }

    // The start URL is deliberately not excluded here: seedSitemapUrls
    // upserts, so a start URL that also appears in the sitemap keeps its
    // link-queue position but gains the in-sitemap flag.
    const seen = new Set<string>();
    const seeds: string[] = [];
    for (const url of result.urls) {
      const normalized = normalizeUrl(url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      if (!isSameOrigin(normalized, origin)) continue;
      if (!isCrawlableUrl(normalized)) continue;
      if (!robots.isAllowed(normalized)) continue;
      seeds.push(normalized);
    }
    for (let i = 0; i < seeds.length; i += SEED_RPC_BATCH) {
      await scratchpad.seedSitemapUrls(seeds.slice(i, i + SEED_RPC_BATCH));
    }
    seededCount += seeds.filter((seed) => seed !== normalizedStart).length;

    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      pagesTotal: Math.min(seededCount, maxPages),
      currentPhase: "crawling",
    });
    return { robotsText: result.robotsText, seededCount };
  });
}

async function finalizeAudit(args: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  crawl: CrawlPhaseResult;
}) {
  const {
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
  } = args;

  await pgStep(step, "multipage-checks", MULTIPAGE_CHECKS_STEP, async () => {
    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "finalizing",
    });

    // Integrity guard: pages are persisted inside crawl-chunk steps. If the
    // crawl claims pages but the DB has none, fail loudly instead of
    // completing with an empty audit.
    if (
      crawl.pagesCrawled > 0 &&
      !(await AuditRepository.hasPagesForAudit(auditId))
    ) {
      throw new Error(
        `Audit ${auditId}: crawl reported ${crawl.pagesCrawled} pages but none were persisted`,
      );
    }

    const checksStartedAt = Date.now();
    console.info("Audit finalization started", { auditId });
    const { issues, hasUnreadShells } = await runMultipageChecks({ auditId });
    console.info("Audit multipage checks completed", {
      auditId,
      durationMs: Date.now() - checksStartedAt,
      issueCount: issues.length,
    });
    const linksStartedAt = Date.now();
    const linkIssues = await runScratchpadLinkChecks(auditId, startUrl, {
      ...crawl,
      completed: crawl.completed && !hasUnreadShells,
    });
    console.info("Audit link checks completed", {
      auditId,
      durationMs: Date.now() - linksStartedAt,
      issueCount: linkIssues.length,
    });
    issues.push(...linkIssues);
    if (crawl.rateLimited) {
      issues.push({
        issueType: "crawl-rate-limited",
        pageId: null,
        pageUrl: startUrl,
      });
    }
    const persistStartedAt = Date.now();
    await AuditRepository.insertIssues(auditId, issues);
    console.info("Audit finalization issues persisted", {
      auditId,
      durationMs: Date.now() - persistStartedAt,
      issueCount: issues.length,
    });
    return { issueCount: issues.length };
  });

  await pgStep(step, "finalize", DB_STEP, async () => {
    const blockedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "blocked",
    );
    const rateLimitedPages = await AuditRepository.countPagesByFetchClass(
      auditId,
      "rate_limited",
    );
    const commitResult = await AuditRepository.completeAudit(
      auditId,
      workflowInstanceId,
      {
        pagesCrawled: crawl.pagesCrawled,
        pagesTotal: crawl.pagesCrawled,
      },
    );
    if (commitResult.kind !== "committed") {
      console.warn("Audit completion conflict or lost CAS race", {
        auditId,
        workflowInstanceId,
      });
      return;
    }
    await captureServerEvent({
      distinctId: billingCustomer.userId,
      event: "site_audit:complete",
      organizationId: billingCustomer.organizationId,
      properties: {
        project_id: projectId,
        status: "completed",
        pages_crawled: crawl.pagesCrawled,
        pages_total: crawl.pagesCrawled,
        crawl_completed: crawl.completed,
        pages_blocked: blockedPages,
        pages_rate_limited: rateLimitedPages,
        run_lighthouse: config.lighthouseStrategy !== "none",
      },
    });
    await AuditProgressKV.clear(auditId);
    // Crawl scratch state (frontier, links, mirror) is no longer needed.
    await getAuditScratchpad(auditId).destroy();
  });
}

/**
 * The two finalize checks that need link edges run as SQL inside the
 * audit's scratchpad DO; map their rows onto DetectedIssue.
 */
async function runScratchpadLinkChecks(
  auditId: string,
  startUrl: string,
  crawl: CrawlPhaseResult,
): Promise<DetectedIssue[]> {
  const scratchpad = getAuditScratchpad(auditId);
  const { brokenLinks, orphanPages } = await scratchpad.runFinalizeChecks({
    // Page rows store normalized URLs; normalize the start URL the same way
    // so the orphan exclusion matches.
    startUrl: normalizeUrl(startUrl) ?? startUrl,
    // Orphan detection only makes sense when the crawl wasn't truncated.
    crawlCompleted: crawl.completed,
  });

  return [
    ...brokenLinks.map((row) => ({
      issueType: "broken-internal-link" as const,
      pageId: row.sourcePageId,
      pageUrl: row.sourceUrl,
      dedupeKey: row.targetUrl,
      details: { targetUrl: row.targetUrl, targetStatus: row.targetStatus },
    })),
    ...orphanPages.map((row) => ({
      issueType: "orphan-page" as const,
      pageId: row.pageId,
      pageUrl: row.url,
    })),
  ];
}
