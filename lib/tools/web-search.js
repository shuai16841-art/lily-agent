export async function webSearch({ query, max_results = 5 }, fetchImpl = fetch) {
  if (!process.env.TAVILY_API_KEY) {
    throw new Error("TAVILY_API_KEY is required for web_search");
  }

  const response = await fetchImpl("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      include_answer: false,
      max_results: Math.min(Math.max(Number(max_results) || 5, 1), 10)
    })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.detail || `Web search failed: HTTP ${response.status}`);
  }

  return (payload?.results || []).map((item) => ({
    title: item.title,
    url: item.url,
    content: item.content,
    score: item.score
  }));
}

export const webSearchDefinition = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the live web for companies, contacts, buyers, factories, and public evidence.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        max_results: { type: "integer", minimum: 1, maximum: 10 }
      },
      required: ["query"]
    }
  }
};
