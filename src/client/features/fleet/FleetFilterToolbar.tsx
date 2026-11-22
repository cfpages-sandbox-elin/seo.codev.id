import { Search } from "lucide-react";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";

export function FleetFilterToolbar({
  search,
  setSearch,
  selectedTier,
  setSelectedTier,
  selectedGrade,
  setSelectedGrade,
  selectedStatus,
  setSelectedStatus,
}: {
  search: string;
  setSearch: (s: string) => void;
  selectedTier: string;
  setSelectedTier: (s: string) => void;
  selectedGrade: string;
  setSelectedGrade: (s: string) => void;
  selectedStatus: string;
  setSelectedStatus: (s: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="relative flex-1 sm:max-w-xs">
        <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
        <Input
          aria-label="Search domains or categories"
          placeholder="Search domain or category..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="min-h-9 pl-8"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 border-r border-border pr-2">
          {["all", "Tier 1", "Tier 2", "Tier 3"].map((t) => (
            <Button
              key={t}
              variant={selectedTier === t ? "default" : "outline"}
              size="sm"
              className="min-h-9 font-medium dark:aria-pressed:text-[oklch(13%_0_0)]"
              aria-pressed={selectedTier === t}
              onClick={() => setSelectedTier(t)}
            >
              {t === "all" ? "All Tiers" : t}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1 border-r border-border pr-2">
          {(["all", "A", "B", "C", "D", "F", "ungraded"] as const).map((g) => (
            <Button
              key={g}
              variant={selectedGrade === g ? "default" : "outline"}
              size="sm"
              className="min-h-9 font-medium dark:aria-pressed:text-[oklch(13%_0_0)]"
              aria-pressed={selectedGrade === g}
              onClick={() => setSelectedGrade(g)}
            >
              {g === "all" ? "All Grades" : g === "ungraded" ? "Ungraded" : g}
            </Button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              "all",
              "fresh_graded",
              "fresh_partial",
              "stale",
              "never_audited",
              "unavailable",
              "exempt",
              "unmapped",
            ] as const
          ).map((st) => (
            <Button
              key={st}
              variant={selectedStatus === st ? "default" : "outline"}
              size="sm"
              className="min-h-9 font-medium dark:aria-pressed:text-[oklch(13%_0_0)]"
              aria-pressed={selectedStatus === st}
              onClick={() => setSelectedStatus(st)}
            >
              {st === "all"
                ? "All Statuses"
                : st === "fresh_graded"
                  ? "Graded"
                  : st === "fresh_partial"
                    ? "Partial"
                    : st === "stale"
                      ? "Stale"
                      : st === "never_audited"
                        ? "Never Audited"
                        : st === "unavailable"
                          ? "Unavailable"
                          : st === "exempt"
                            ? "Exempt"
                            : "Unmapped"}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
