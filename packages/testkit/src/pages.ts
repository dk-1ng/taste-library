export interface HtmlPageOptions {
  title?: string;
  /** Raw HTML placed inside `<body>`. */
  body?: string;
  /** `src` of images to include, in order. */
  images?: readonly string[];
  /** Use CRLF line endings instead of LF. */
  crlf?: boolean;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A small, valid HTML page. Output depends only on the options. */
export function makeHtmlPage(options: HtmlPageOptions = {}): string {
  const { title = "Fixture page", body = "<p>Synthetic fixture.</p>", images = [], crlf } = options;
  const lines = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    "</head>",
    "<body>",
    `<h1>${escapeHtml(title)}</h1>`,
    body,
    ...images.map((src) => `<img src="${escapeHtml(src)}" alt="">`),
    "</body>",
    "</html>",
    "",
  ];
  return lines.join(crlf ? "\r\n" : "\n");
}
