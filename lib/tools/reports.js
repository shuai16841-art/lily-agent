import fs from "node:fs/promises";
import path from "node:path";

function safeName(value) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80);
}

export async function generateReportFile({ task_id, title, markdown }) {
  const defaultRoot = process.env.VERCEL
    ? path.join(process.env.TMPDIR || "/tmp", "lily-reports")
    : "outputs/reports";
  const root = path.resolve(process.env.LILY_REPORT_DIR || defaultRoot);
  await fs.mkdir(root, { recursive: true });
  const filename = `${safeName(title || task_id || "lily-report") || "lily-report"}.md`;
  const outputPath = path.join(root, filename);
  await fs.writeFile(outputPath, `# ${title || "Lily Report"}\n\n${markdown.trim()}\n`, "utf8");
  return {
    path: outputPath,
    filename
  };
}

export const reportDefinition = {
  type: "function",
  function: {
    name: "generate_report",
    description: "Generate a Markdown report file from completed, verified task results.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        title: { type: "string" },
        markdown: { type: "string" }
      },
      required: ["title", "markdown"]
    }
  }
};
