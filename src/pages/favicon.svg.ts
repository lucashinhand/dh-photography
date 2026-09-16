export const prerender = true;

const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-labelledby="title"><title>David Hahn Photography</title><rect width="64" height="64" fill="#171713"/><path d="M15 15h12.5C39.9 15 47 21.3 47 32s-7.1 17-19.5 17H15V15Zm9 7v20h3.1c6.8 0 10.9-2.9 10.9-10s-4.1-10-10.9-10H24Z" fill="#f8f7f3"/></svg>`;

export function GET() {
  return new Response(favicon, {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8' },
  });
}
