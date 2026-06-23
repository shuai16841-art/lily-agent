import { processLeads } from "./lead-pipeline.js";

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function safeSentence(value, fallback = "") {
  const clean = text(value)
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .trim();
  if (!clean || /^[{[]/.test(clean)) return fallback;
  return clean;
}

export function formatCleanLead(lead, index) {
  return [
    `${index + 1}. ${lead.company}`,
    `Website: ${lead.website}`,
    `Email: ${lead.email || "Not publicly listed"}`,
    `Phone: ${lead.phone || "Not publicly listed"}`,
    `Location: ${lead.location || "Not publicly listed"}`,
    `Relevance: ${lead.relevance}`,
    `Confidence: ${lead.confidence_score}%`
  ].join("\n");
}

export function formatCleanResult(result = {}) {
  const sections = [
    `Task completed: ${safeSentence(result.summary, "Research completed.")}`
  ];
  const leads = processLeads([
    ...(Array.isArray(result.buyers) ? result.buyers : []),
    ...(Array.isArray(result.factories) ? result.factories : [])
  ]);
  if (leads.length) {
    sections.push(
      `Verified leads (${leads.length}):\n\n${leads
        .map(formatCleanLead)
        .join("\n\n")}`
    );
  }
  const notes = Array.isArray(result.notes)
    ? result.notes.map((note) => safeSentence(note)).filter(Boolean)
    : [];
  if (notes.length) {
    sections.push(`Notes:\n${notes.map((note) => `- ${note}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

export function formatSafeText(value, fallback = "Task completed.") {
  return safeSentence(value, fallback);
}
