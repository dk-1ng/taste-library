import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { makeHtmlPage, makePng } from "@tastelib/testkit";
import { expect, test } from "@playwright/test";

// A local server on an OS-assigned port serving generated content: no network, no committed media.
let server: Server;
let baseUrl: string;

test.beforeAll(async () => {
  const page = makeHtmlPage({ title: "Placeholder", images: ["/pixel.png"] });
  const png = makePng(8, 6, 1);
  server = createServer((req, res) => {
    if (req.url === "/pixel.png") {
      res.writeHead(200, { "content-type": "image/png" }).end(png);
    } else {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("renders a generated page and its generated image", async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "Placeholder" })).toBeVisible();
  const size = await page.locator("img").evaluate((el) => {
    const img = el as unknown as { naturalWidth: number; naturalHeight: number };
    return [img.naturalWidth, img.naturalHeight];
  });
  expect(size).toEqual([8, 6]);
});
