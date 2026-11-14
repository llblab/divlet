// CSS data, never parser sidecar instructions. Shared by Node and actual browser codec witnesses.
export const cssAnnotationCases = [
  ['unsupported inline-map encoding', 'data:application/json;unsupported,opaque'],
  ['malformed inline-map URI encoding', 'data:application/json,%ZZ'],
  ['non-map inline payload', 'data:application/json;base64,bm90LWpzb24='],
  ['local sidecar-looking text', 'unrequested.map'],
  ['network sidecar-looking text', 'https://example.invalid/unrequested.map'],
].map(([name, url]) => {
  const comment = `/*# sourceMappingURL=${url} */`;
  const literal = JSON.stringify(comment);
  return { name, comment, literal, html: `<main style='content:${literal}'></main>` };
});
