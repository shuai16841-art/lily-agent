const DIRECTORY_HOSTS = [
  "mapquest.com",
  "yelp.com",
  "yellowpages.com",
  "facebook.com",
  "linkedin.com",
  "instagram.com",
  "bbb.org",
  "manta.com"
];
const BOILERPLATE = /^(?:home|contact us|about us|learn more|click here|advertisement|sponsored)$/i;

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function websiteHost(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function confidenceValue(value, lead) {
  const supplied = Number(value);
  if (Number.isFinite(supplied)) {
    return Math.max(0, Math.min(100, Math.round(supplied)));
  }
  let score = 30;
  if (lead.website) score += 25;
  if (lead.email) score += 20;
  if (lead.phone) score += 15;
  if (lead.location) score += 10;
  return Math.min(score, 100);
}

export function normalizeLead(input = {}) {
  const company = text(input.company || input.company_name);
  const website = text(input.website);
  const lead = {
    company,
    website,
    email: text(input.email),
    phone: text(input.phone),
    location: text(input.location || input.address),
    relevance: text(
      input.relevance ||
        input.reason_good_lead ||
        input.reason ||
        (input.evidence_url ? "Verified from a public business source" : "")
    ),
    confidence_score: 0
  };
  lead.confidence_score = confidenceValue(
    input.confidence_score || input.confidence,
    lead
  );
  return lead;
}

export function isQualifiedLead(lead) {
  if (!lead.company || BOILERPLATE.test(lead.company)) {
    return false;
  }
  const host = websiteHost(lead.website);
  if (!host || DIRECTORY_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return false;
  }
  if (!lead.relevance || lead.confidence_score < 40) {
    return false;
  }
  return true;
}

export function processLeads(inputs = []) {
  const seen = new Set();
  return inputs
    .map(normalizeLead)
    .filter(isQualifiedLead)
    .filter((lead) => {
      const key = `${lead.company.toLowerCase()}|${websiteHost(lead.website)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.confidence_score - a.confidence_score);
}

export function buildLeadResult(result = {}) {
  return {
    summary: text(result.summary) || "Research completed.",
    buyers: processLeads(result.buyers),
    factories: processLeads(result.factories),
    notes: Array.isArray(result.notes)
      ? result.notes.map(text).filter(Boolean)
      : [],
    partial: Boolean(result.partial),
    output_format: "clean_leads"
  };
}
