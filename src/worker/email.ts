// Email notifications via Resend

export async function sendDailyEmail(
  apiKey: string,
  email: string,
  userId: string,
  topListings: any[],
  stats: { newCount: number; removedCount: number; priceChanges: number }
) {
  const today = new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const subject = `SF House Scan — ${today}: ${stats.newCount} new, ${stats.removedCount} removed, ${stats.priceChanges} price changes`;

  const listingsRows = topListings
    .slice(0, 10)
    .map(
      (l, i) => `
    <tr style="${i % 2 === 0 ? "" : "background:#fafafa;"}">
      <td style="padding:4px 6px;">${i + 1}</td>
      <td><a href="${l.url || "#"}" style="color:#2563eb; text-decoration:none;">${l.address?.split(",")[0] || "—"}</a></td>
      <td style="text-align:right;">$${l.price ? (l.price / 1000).toFixed(0) + "K" : "?"}</td>
      <td style="text-align:center;">${l.bedrooms || "?"}/${l.bathrooms || "?"}</td>
      <td>${l.neighborhood || "—"}</td>
      <td style="text-align:right; font-weight:bold; ${l.score >= 85 ? "color:#2563eb;" : ""}">${l.score}</td>
    </tr>`
    )
    .join("");

  const explanations = topListings
    .slice(0, 5)
    .map(
      (l) =>
        `<p style="margin:4px 0;"><strong>${l.address?.split(",")[0]}</strong> (${l.score}): ${l.explanation || "No explanation generated."}</p>`
    )
    .join("");

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto; color: #1a1a1a;">
  <h2 style="margin-bottom: 4px;">HomeScout</h2>
  <p style="color: #666; margin-top: 0;">${today} · ${topListings.length} active listings scored</p>
  <hr style="border: 1px solid #eee;">

  <h3>Top 10</h3>
  <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
    <tr style="background: #f5f5f5;">
      <th style="text-align:left; padding: 6px;">#</th>
      <th style="text-align:left; padding: 6px;">Address</th>
      <th style="text-align:right; padding: 6px;">Price</th>
      <th style="padding: 6px;">Bd/Ba</th>
      <th style="padding: 6px;">Area</th>
      <th style="text-align:right; padding: 6px;">Score</th>
    </tr>
    ${listingsRows}
  </table>

  ${explanations ? `<hr style="border: 1px solid #eee;"><h3>Why These Scored High</h3>${explanations}` : ""}

  <hr style="border: 1px solid #eee;">
  <h3>Today's Changes</h3>
  <p>
    ${stats.newCount > 0 ? `<strong style="color:#16a34a;">+${stats.newCount} new listings</strong><br>` : ""}
    ${stats.removedCount > 0 ? `<strong style="color:#dc2626;">${stats.removedCount} removed (sold/pending)</strong><br>` : ""}
    ${stats.priceChanges > 0 ? `<strong style="color:#d97706;">${stats.priceChanges} price changes</strong><br>` : ""}
    ${stats.newCount === 0 && stats.removedCount === 0 && stats.priceChanges === 0 ? "No changes today." : ""}
  </p>

  <hr style="border: 1px solid #eee;">
  <p style="text-align:center; margin-top: 16px;">
    <a href="https://homescout.pages.dev/dashboard/${userId}" style="background:#2563eb; color:white; padding:10px 24px; border-radius:6px; text-decoration:none; font-weight:bold;">View Dashboard</a>
  </p>
  <p style="text-align:center; color:#999; font-size:12px; margin-top:16px;">
    HomeScout · Personalized home search intelligence
  </p>
</div>`;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "HomeScout <onboarding@resend.dev>",
      to: email,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    console.error("Resend error:", await response.text());
  }

  return response.ok;
}
