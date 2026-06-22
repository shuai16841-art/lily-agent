export async function appendGoogleSheetRows(
  { spreadsheet_id, range = "Sheet1!A:Z", rows },
  fetchImpl = fetch
) {
  if (!process.env.GOOGLE_ACCESS_TOKEN) {
    return {
      skipped: true,
      reason:
        "Google Sheets is not configured. Results will still be returned directly."
    };
  }
  const spreadsheetId = spreadsheet_id || process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  if (!spreadsheetId) {
    return {
      skipped: true,
      reason:
        "No Google Sheets spreadsheet was specified. Results will still be returned directly."
    };
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
    description:
      "Append reviewed task results to Google Sheets only when the user explicitly asks for a Google Sheet.",
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
