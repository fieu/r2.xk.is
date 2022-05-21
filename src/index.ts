import parseRange from "range-parser";

let homePage:string = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>💾</text></svg>">
<title>&#x5D0;</title>
<style>
        body {
            font-family: sans-serif;
            line-height: 1.3;
        }

        main {
            max-width: 600px;
            padding: 24px;
            margin: auto;
        }

        article>* {
            margin: 0 0 24px;
        }
    </style>
</head>
<body>
<main>
<h1><code>r2.xk.is</code> <small style="color:gray;font-size:20px;"></small></h1>
<p>a place to store my files.</p>
<footer>
<p>by <a target="_blank" rel="nofollow" href="https://fieu.cc">fieu</a></p>
</footer>
</main>
</body>
</html>
`

interface Env {
  R2_BUCKET: R2Bucket,
  CACHE_CONTROL: string
}

function hasBody(object: R2Object | R2ObjectBody): object is R2ObjectBody {
  return (<R2ObjectBody>object).body !== undefined;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const allowedMethods = ["GET", "HEAD", "OPTIONS"];
    if (allowedMethods.indexOf(request.method) === -1) return new Response("Method Not Allowed", { status: 405 });

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "allow": allowedMethods.join(", ") } })
    }

    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response(homePage, {
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
        }
      });
    }

    const cache = caches.default;
    let response = await cache.match(request);
    let range: R2Range | undefined;

    if (!response || !response.ok) {
      console.warn("Cache miss");
      const path = decodeURIComponent(url.pathname.substring(1));

      let file: R2Object | R2ObjectBody | null | undefined;

      // Range handling
      if (request.method === "GET") {
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          file = await env.R2_BUCKET.head(path);
          if (file === null) return new Response("File Not Found", { status: 404 });
          const parsedRanges = parseRange(file.size, rangeHeader);
          // R2 only supports 1 range at the moment, reject if there is more than one
          if (parsedRanges !== -1 && parsedRanges !== -2 && parsedRanges.length === 1 && parsedRanges.type === "bytes") {
            let firstRange = parsedRanges[0];
            range = {
              offset: firstRange.start,
              length: firstRange.end - firstRange.start + 1
            }
          } else {
            return new Response("Range Not Satisfiable", { status: 416 });
          }
        }
      }

      // Etag/If-(Not)-Match handling
      // R2 requires that etag checks must not contain quotes, and the S3 spec only allows one etag
      // This silently ignores invalid or weak (W/) headers
      const getHeaderEtag = (header: string | null) => header?.trim().replace(/^['"]|['"]$/g, "");
      const ifMatch = getHeaderEtag(request.headers.get("if-match"));
      const ifNoneMatch = getHeaderEtag(request.headers.get("if-none-match"));

      const ifModifiedSince = Date.parse(request.headers.get("if-modified-since") || "");
      const ifUnmodifiedSince = Date.parse(request.headers.get("if-unmodified-since") || "");

      const ifRange = request.headers.get("if-range");
      if (range && ifRange && file) {
        const maybeDate = Date.parse(ifRange);

        if (isNaN(maybeDate) || new Date(maybeDate) > file.uploaded) {
          // httpEtag already has quotes, no need to use getHeaderEtag
          if (ifRange.startsWith("W/") || ifRange !== file.httpEtag) range = undefined;
        }
      }

      if (ifMatch || ifUnmodifiedSince) {
        file = await env.R2_BUCKET.get(path, {
          onlyIf: {
            etagMatches: ifMatch,
            uploadedBefore: ifUnmodifiedSince ? new Date(ifUnmodifiedSince) : undefined
          }, range
        });

        if (file && !hasBody(file)) {
          return new Response("Precondition Failed", { status: 412 });
        }
      }

      if (ifNoneMatch || ifModifiedSince) {
        // if-none-match overrides if-modified-since completely
        if (ifNoneMatch) {
          file = await env.R2_BUCKET.get(path, { onlyIf: { etagDoesNotMatch: ifNoneMatch }, range });
        } else if (ifModifiedSince) {
          file = await env.R2_BUCKET.get(path, { onlyIf: { uploadedAfter: new Date(ifModifiedSince) }, range });
        }
        if (file && !hasBody(file)) {
          return new Response(null, { status: 304 });
        }
      }

      file = request.method === "HEAD"
        ? await env.R2_BUCKET.head(path)
        : ((file && hasBody(file)) ? file : await env.R2_BUCKET.get(path, { range }));

      if (file === null) {
        return new Response("File Not Found", { status: 404 });
      }

      response = new Response(hasBody(file) ? file.body : null, {
        status: (file?.size || 0) === 0 ? 204 : (range ? 206 : 200),
        headers: {
          "accept-ranges": "bytes",

          "etag": file.httpEtag,
          "cache-control": file.httpMetadata.cacheControl ?? (env.CACHE_CONTROL || ""),
          "expires": file.httpMetadata.cacheExpiry?.toUTCString() ?? "",
          "last-modified": file.uploaded.toUTCString(),

          "content-encoding": file.httpMetadata?.contentEncoding ?? "",
          "content-type": file.httpMetadata?.contentType ?? "application/octet-stream",
          "content-language": file.httpMetadata?.contentLanguage ?? "",
          "content-disposition": file.httpMetadata?.contentDisposition ?? "",
          "content-range": range ? `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}` : "",
        }
      });
    }

    if (request.method === "GET" && !range)
      ctx.waitUntil(cache.put(request, response.clone()));

    return response;
  },
};
