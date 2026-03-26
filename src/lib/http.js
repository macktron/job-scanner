import { stripHtml, truncate } from "./utils.js";

export async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs || 20_000),
    headers: {
      "user-agent": "job-scanner-bot/0.1 (+https://github.com/actions)",
      "accept-language": "en-US,en;q=0.9,sv-SE;q=0.8",
      ...(options.headers || {})
    }
  });

  return {
    ok: response.ok,
    status: response.status,
    url: response.url,
    text: await response.text()
  };
}

export async function fetchCareerSnapshots(company, options = {}) {
  const urls = company.careerUrls.slice(0, options.maxUrls || 2);
  const snapshots = [];

  for (const url of urls) {
    try {
      const response = await fetchText(url, { timeoutMs: options.timeoutMs || 20_000 });
      snapshots.push({
        requested_url: url,
        final_url: response.url,
        status: response.status,
        ok: response.ok,
        excerpt: truncate(stripHtml(response.text), options.maxChars || 6_000)
      });
    } catch (error) {
      snapshots.push({
        requested_url: url,
        final_url: url,
        status: null,
        ok: false,
        excerpt: "",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return snapshots;
}
