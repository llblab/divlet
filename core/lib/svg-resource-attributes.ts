// Owns the shared SVG attribute vocabulary for CSS resource carriers, not XML parsing or resource resolution.
export const SVG_RESOURCE_ATTRIBUTES: ReadonlySet<string> = new Set('fill stroke filter mask clip-path marker marker-start marker-mid marker-end cursor color-profile'.split(' '));
