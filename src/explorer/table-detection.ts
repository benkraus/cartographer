import type { Page } from "playwright";

import type { UIStatePacket } from "../contracts/state-packet.js";

type TableOrListExtract = NonNullable<UIStatePacket["ui"]["tables_or_lists"]>[number];

interface RawTableExtract {
  list_id: string;
  title?: string;
  columns?: string[];
  row_actions_present?: boolean;
  pagination_present?: boolean;
  filters_present?: boolean;
}

const TABLE_OR_LIST_SELECTOR = ["table", "[role='table']", "[role='grid']", "[role='list']", "ul", "ol"].join(",");

export async function extractTablesOrLists(page: Page, maxItems = 15): Promise<TableOrListExtract[]> {
  const raw = await page.evaluate<RawTableExtract[], { selector: string; maxItems: number }>(
    ({ selector, maxItems: maxResults }) => {
      const containers = Array.from(document.querySelectorAll(selector)).slice(0, maxResults * 2);
      const output: RawTableExtract[] = [];

      for (let index = 0; index < containers.length; index += 1) {
        const container = containers[index];
        if (!container) {
          continue;
        }

        const listId = `list_${index + 1}`;
        let title: string | undefined;
        const ariaLabel = container.getAttribute("aria-label")?.trim();
        if (ariaLabel) {
          title = ariaLabel;
        } else if (container instanceof HTMLTableElement) {
          const caption = container.caption?.textContent?.trim();
          if (caption) {
            title = caption;
          }
        }
        if (!title) {
          const heading = container
            .closest("section, article, main, div")
            ?.querySelector("h1, h2, h3, [role='heading']")
            ?.textContent?.trim();
          if (heading) {
            title = heading;
          }
        }

        const columns = Array.from(container.querySelectorAll("th, [role='columnheader']"))
          .map((node) => node.textContent?.trim() ?? "")
          .filter((value) => value.length > 0)
          .slice(0, 20);

        let rowActionsPresent = false;
        const rows = Array.from(container.querySelectorAll("tbody tr, [role='row']")).slice(0, 5);
        for (const row of rows) {
          const actions = row.querySelectorAll("button, a[href], [role='button'], [role='link'], [role='menuitem']");
          if (actions.length > 0) {
            rowActionsPresent = true;
            break;
          }
        }

        let paginationPresent = false;
        const localPagination = container.querySelector("[aria-label*='page' i], [class*='pagination' i], [role='navigation']");
        if (localPagination) {
          paginationPresent = true;
        } else {
          const nextCandidate = Array.from(document.querySelectorAll("button, a[href]")).find((node) => {
            const text = (node.textContent ?? "").trim().toLowerCase();
            return /\b(next|previous|prev|older|newer)\b/.test(text);
          });
          paginationPresent = Boolean(nextCandidate);
        }

        let filtersPresent = false;
        const filterInput = container.querySelector(
          "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i], select",
        );
        if (filterInput) {
          filtersPresent = true;
        } else {
          const nearbyFilter = container.closest("section, article, div")?.querySelector(
            "input[type='search'], input[placeholder*='search' i], input[placeholder*='filter' i], select",
          );
          filtersPresent = Boolean(nearbyFilter);
        }

        const item: RawTableExtract = {
          list_id: listId,
          row_actions_present: rowActionsPresent,
          pagination_present: paginationPresent,
          filters_present: filtersPresent,
        };

        if (title) {
          item.title = title;
        }
        if (columns.length > 0) {
          item.columns = columns;
        }

        output.push(item);
        if (output.length >= maxResults) {
          break;
        }
      }

      return output;
    },
    { selector: TABLE_OR_LIST_SELECTOR, maxItems },
  );

  return raw.map((item) => {
    const normalized: TableOrListExtract = {
      list_id: item.list_id,
    };
    if (item.title) {
      normalized.title = item.title;
    }
    if (item.columns) {
      normalized.columns = item.columns;
    }
    if (typeof item.row_actions_present === "boolean") {
      normalized.row_actions_present = item.row_actions_present;
    }
    if (typeof item.pagination_present === "boolean") {
      normalized.pagination_present = item.pagination_present;
    }
    if (typeof item.filters_present === "boolean") {
      normalized.filters_present = item.filters_present;
    }
    return normalized;
  });
}
