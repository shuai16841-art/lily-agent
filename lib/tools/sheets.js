export async function appendGoogleSheetRows(
  { spreadsheet_id, range = "Sheet1!A:Z", rows },
  fetchImpl = fetch
) {
  if (!process.env.GOOGLE_ACCESS_TOKEN) {
    throw new Error("GOOGLE_ACCESS_TOKEN is required for Google Sheets");
  }
  const spreadsheetId = spreadsheet_id || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    throw new Error("GOOGLE_SHEETS_SPREADSHEET_ID is required");
  }

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GOOGLE_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values: rows })
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Google Sheets write failed: HTTP ${response.status}`);
  }
  return payload;
}

export const sheetsAppendDefinition = {
  type: "function",
  function: {
    name: "google_sheets_append",
    description: "Append reviewed task results to a Google Sheet.",
    parameters: {
      type: "object",
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
        rows: {
          type: "array",
          items: {
            type: "array",
            items: {}
          }
        }
      },
      required: ["rows"]
    }
  }
};
