import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import type { FleetDomainSummary } from "@/server/features/fleet/services/FleetService";
import type { SortDirection, SortField } from "./fleetTypes";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/client/components/ui/table";
import { FleetMatrixRow } from "./FleetMatrixRow";

function SortHeader({
  field,
  label,
  currentField,
  direction,
  onSort,
  align = "left",
}: {
  field: SortField;
  label: string;
  currentField: SortField;
  direction: SortDirection;
  onSort: (f: SortField) => void;
  align?: "left" | "center" | "right";
}) {
  const active = currentField === field;
  const alignClass =
    align === "right"
      ? "text-right ml-auto"
      : align === "center"
        ? "text-center mx-auto"
        : "text-left";

  return (
    <TableHead
      className={
        align === "right"
          ? "text-right"
          : align === "center"
            ? "text-center"
            : ""
      }
      aria-sort={
        active ? (direction === "asc" ? "ascending" : "descending") : undefined
      }
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`flex min-h-9 items-center gap-1 font-medium hover:text-foreground ${alignClass}`}
      >
        <span>{label}</span>
        {active ? (
          direction === "asc" ? (
            <ArrowUp className="size-3 text-primary" aria-hidden="true" />
          ) : (
            <ArrowDown className="size-3 text-primary" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown
            className="size-3 text-muted-foreground"
            aria-hidden="true"
          />
        )}
      </button>
    </TableHead>
  );
}

export function FleetMatrixTable({
  domains,
  sortField,
  sortDirection,
  onSort,
}: {
  domains: FleetDomainSummary[];
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Table
        containerProps={{
          role: "region",
          "aria-label": "Fleet matrix",
          tabIndex: 0,
        }}
        containerClassName="focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
      >
        <caption className="sr-only">
          Aggregated On-Site Technical SEO Fleet Matrix
        </caption>
        <TableHeader>
          <TableRow>
            <SortHeader
              field="host"
              label="Domain"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortHeader
              field="category"
              label="Category"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortHeader
              field="tier"
              label="Tier"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortHeader
              field="platform"
              label="Platform"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
            />
            <SortHeader
              field="score"
              label="Score"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="center"
            />
            <SortHeader
              field="grade"
              label="Grade"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="center"
            />
            <SortHeader
              field="status"
              label="Status"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="center"
            />
            <SortHeader
              field="trend"
              label="Trend"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="center"
            />
            <SortHeader
              field="coverage"
              label="Coverage"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="right"
            />
            <SortHeader
              field="crawl"
              label="Crawl (35%)"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="right"
            />
            <SortHeader
              field="links"
              label="Links (20%)"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="right"
            />
            <SortHeader
              field="lab"
              label="Lab (15%)"
              currentField={sortField}
              direction={sortDirection}
              onSort={onSort}
              align="right"
            />
            <TableHead className="text-right">Action</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {domains.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={13}
                className="h-24 text-center text-muted-foreground"
              >
                No properties match the selected filters.
              </TableCell>
            </TableRow>
          ) : (
            domains.map((domain) => (
              <FleetMatrixRow key={domain.memberId} domain={domain} />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
