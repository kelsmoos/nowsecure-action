/*
 * Copyright © 2021-2022 NowSecure Inc.
 *
 * SPDX-License-Identifier: MIT
 */

import type {
  Log,
  Run,
  ReportingDescriptor,
  Result,
  Notification,
  PhysicalLocation,
} from "sarif";
import crypto from "crypto";
import type { PullReportResponse } from "./nowsecure-types";
import { ripGrep as rg, RipGrepError } from "ripgrep-js";

const SARIF_SCHEMA_URL =
  "https://raw.githubusercontent.com/schemastore/schemastore/master/src/schemas/json/sarif-2.1.0-rtm.5.json";

/**
 * Take the SHA256 of an input string and output in hex.
 */
function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Convert NowSecure severity to a SARIF notification level.
 */
function severityToNotification(input: string): Notification.level {
  if (input === "info") {
    return "note";
  } else if (input === "medium") {
    return "warning";
  } else if (input === "low") {
    return "warning";
  } else if (input === "high") {
    return "error";
  } else {
    // NOTE: In practice, this should never happen.
    return "note";
  }
}

/**
 * Convert a Platform report to Sarif.
 *
 * The data **must** be provided from the GraphQL query in the root of the repository,
 * otherwise data may be missing, in which case the behavior of this function
 * is undefined.
 */
export async function convertToSarif(
  data: PullReportResponse,
  labUrl: string
): Promise<Log> {
  const assessment = data.data.auto.assessments[0];
  const { taskId, applicationRef } = assessment;
  const report = assessment.report;
  if (!report) {
    throw new Error("No report data");
  }

  const rules: ReportingDescriptor[] = [];
  for (const finding of report.findings) {
    if (!finding.affected) continue;

    let markdown = "";
    let issueSummary = "No issue description available.\n";
    if (finding.summary) {
      issueSummary = finding.summary;
    }
    const tags: string[] = [];

    const issue = finding.check.issue;
    if (issue) {
      if (issue.category) {
        tags.push(issue.category);
      }

      if (issue.cvss) {
        tags.push(`CVSS-${issue.cvss.toFixed(2)}`);
      }

      if (issue.impactSummary) {
        markdown += `## Business Impact\n${issue.impactSummary}\n`;
      }

      if (issue.stepsToReproduce) {
        markdown += `## Steps to Reproduce\n${issue.stepsToReproduce}\n`;
      }

      if (issue.recommendation || issue.codeSamples || issue.guidanceLinks) {
        markdown += "## Remediation Resources\n";
      }

      if (issue.recommendation) {
        markdown += `### Recommended Fix\n${issue.recommendation}\n`;
      }

      if (issue.codeSamples && issue.codeSamples.length !== 0) {
        markdown += "## Code Samples\n";

        for (const codeSample of issue.codeSamples) {
          markdown += "<details>\n";
          markdown += `<summary>${codeSample.caption} (click to expand)</summary>\n\n`;
          markdown += "```";
          if (codeSample.syntax) {
            markdown += codeSample.syntax;
          }
          markdown += "\n";
          markdown += codeSample.block;
          markdown += "\n```\n";
          markdown += "</details>\n";
        }
      }

      markdown += "\n";

      if (issue.guidanceLinks && issue.guidanceLinks.length !== 0) {
        markdown += "## Additional Guidance\n";
        for (const guidanceLink of issue.guidanceLinks) {
          markdown += `* ${guidanceLink.caption} ${guidanceLink.url}\n`;
        }
      }

      markdown += "\n";
    }

    // Format NowSecure evidence in a Markdown table, when possible.

    const context = finding.context;
    if (context && context.rows && context.rows.length > 0) {
      // Markdown tables look like:
      // |A|B|C|
      let markdownHeader = "|";
      // |-|-|-|
      let markdownDivider = "|";
      // If the key for "A" is "a", then it will be the first
      // entry in the ordering list, so on...
      const ordering = [];

      for (const fieldName of Object.keys(context.fields)) {
        const fieldTitle = context.fields[fieldName].title;
        markdownHeader += `${fieldTitle}|`;
        markdownDivider += `-|`;
        ordering.push(fieldName);
      }

      markdown += markdownHeader + "\n";
      markdown += markdownDivider + "\n";

      // For each row, insert keys in the order specified in "ordering".
      for (const row of context.rows) {
        markdown += "|";
        for (const key of ordering) {
          let data = row[key];
          if (typeof data !== "string") {
            data = JSON.stringify(data);
          }

          markdown += "```` " + data + " ````" + "|";
        }
        markdown += "\n";
      }
    }

    rules.push({
      id: sha256(finding.key),
      name: finding.title,
      helpUri: `${labUrl}/app/${applicationRef}/assessment/${taskId}#finding-${finding.key}`,
      shortDescription: {
        text: finding.title,
      },
      fullDescription: {
        text: issueSummary,
      },
      defaultConfiguration: {
        level: severityToNotification(finding.severity),
      },
      properties: {
        problem: {
          severity: finding.severity,
        },
        tags,
        precision: "medium",
      },
      help: {
        // NOTE: In practice this should not display on the GitHub UI.
        text: "NowSecure only provides recommendations in a Markdown format.",
        markdown,
      },
    });
  }

  const results: Result[] = [];
  for (const finding of report.findings) {
    if (!finding.affected) continue;

    const issue = finding.check.issue;

    let issueDescription = "No issue description available\n";
    if (issue && issue.description) {
      issueDescription = issue.description;
    }

    // If we are missing a specialized result for a rule, show the "simple"
    // result that does not show detailed line number information (refer to the
    // evidence table instead).
    const simpleResult = {
      ruleId: sha256(finding.key),
      message: {
        // Markdown doesn't work here. We render our information in the "help"
        // field in the reporting descriptor.
        text: issueDescription,
      },
      locations: [
        {
          // We don't have line number information so instead produce phony
          // information for a file that does not exist.
          physicalLocation: {
            artifactLocation: {
              uri: "Unknown",
              uriBaseId: "%SRCROOT%",
            },
            region: {
              startLine: 1,
              endLine: 1,
              byteOffset: 0,
              byteLength: 0,
            },
          },
        },
      ],
    };

    // FIXME: This should be refactored out and abstracted.
    const localResults = [];

    if (finding.key == "path_traversal") {
      const context = finding.context;
      if (context && context.rows && context.rows.length > 0) {
        for (const row of context.rows) {
          const name = row.name as string;
          const namespace = name.split(".");
          if (namespace.length > 0) {
            const [className] = namespace.slice(-1);
            // NOTE: Source mapping works for Java and Kotlin ONLY.
            const locations = await searchLocations(`class ${className}`);

            for (const physicalLocation of locations) {
              localResults.push({
                ruleId: sha256(finding.key),
                message: {
                  text: issueDescription,
                },
                locations: [
                  {
                    physicalLocation,
                  },
                ],
              });
            }
          }
        }
      }
    }

    if (localResults.length !== 0) {
      results.push(...localResults);
    } else {
      results.push(simpleResult);
    }
  }

  const run: Run = {
    tool: {
      driver: {
        name: "NowSecure",
        informationUri: "https://www.nowsecure.com/",
        semanticVersion: "1.0.0",
        rules,
      },
    },
    results,
  };

  const log: Log = {
    $schema: SARIF_SCHEMA_URL,
    version: "2.1.0",
    runs: [run],
  };

  return log;
}

function strip(name: string): string {
  return name.replace(/[^0-9a-z-_\s]/gi, "");
}

/*
 * Search the codebase for a string and return a physical location that corresponds
 * to it.
 */
async function searchLocations(name: string): Promise<PhysicalLocation[]> {
  let results;
  try {
    results = await rg("./", `"${strip(name)}"`);
  } catch (e) {
    const error = e as RipGrepError;
    console.log(`Error: ripgrep: ${error.message}: ${error.stderr}`);
    console.log(
      "Note: ripgrep is required for line-number identification. On Ubuntu-based distributions use `apt-get install -y ripgrep` before running the NowSecure action"
    );
    return [];
  }

  const locations = [];

  for (const result of results) {
    locations.push({
      artifactLocation: {
        uri: result.path.text,
        uriBaseId: "%SRCROOT%",
      },
      region: {
        startLine: result.line_number,
        endLine: result.line_number,
        byteOffset: 0,
        byteLength: 0,
      },
    });
  }

  return locations;
}
