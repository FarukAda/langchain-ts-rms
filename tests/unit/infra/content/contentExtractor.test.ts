import { describe, it, expect } from "vitest";
import { extractTextFromHtml } from "../../../../src/infra/content/contentExtractor.js";

describe("extractTextFromHtml", () => {
  it("extracts text from a simple HTML page", () => {
    const html = `
      <html>
        <body>
          <h1>Hello World</h1>
          <p>This is a test paragraph with useful content for research purposes.</p>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 4000);
    expect(result).toContain("Hello World");
    expect(result).toContain("useful content for research purposes");
  });

  it("strips script and style elements", () => {
    const html = `
      <html>
        <body>
          <script>alert('bad');</script>
          <style>.hidden { display: none; }</style>
          <p>Visible content here for the research extraction test.</p>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 4000);
    expect(result).not.toContain("alert");
    expect(result).not.toContain("display: none");
    expect(result).toContain("Visible content");
  });

  it("strips nav, footer, header, aside elements", () => {
    const html = `
      <html>
        <body>
          <nav>Navigation menu links here</nav>
          <header>Site header banners and links</header>
          <main><p>Main content for research purposes with important details.</p></main>
          <footer>Copyright 2026 and footer links</footer>
          <aside>Sidebar links and advertisements</aside>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 4000);
    expect(result).not.toContain("Navigation menu");
    expect(result).not.toContain("Copyright 2026");
    expect(result).not.toContain("Sidebar links");
    expect(result).toContain("Main content");
  });

  it("prefers <article> over <body> when present", () => {
    const html = `
      <html>
        <body>
          <div>Random body content outside article element.</div>
          <article>
            <h2>Article Title for Important Research</h2>
            <p>This is the article content with specific facts and details.</p>
          </article>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 4000);
    expect(result).toContain("Article Title");
    expect(result).not.toContain("Random body content");
  });

  it("prefers <main> when <article> is absent", () => {
    const html = `
      <html>
        <body>
          <div>Random body text outside the main element.</div>
          <main>
            <p>Main section content with valuable information for research.</p>
          </main>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 4000);
    expect(result).toContain("Main section content");
    expect(result).not.toContain("Random body text");
  });

  it("truncates to maxChars", () => {
    const html = `
      <html>
        <body>
          <p>${"A".repeat(5000)}</p>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("collapses whitespace", () => {
    const html = `
      <html>
        <body>
          <p>Multiple     spaces    and
          
          
          newlines    in    this  content  paragraph.</p>
        </body>
      </html>
    `;
    const result = extractTextFromHtml(html, 4000);
    expect(result).not.toMatch(/\s{2,}/);
  });
});
