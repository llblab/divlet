// Domain: Tailwind renderer source contract. Owns: portable captured CSS/profile data. Excludes: discovery, hashing, compilation and registration.
export const STYLESHEETS = ['index.css', 'theme.css', 'preflight.css', 'utilities.css'] as const;
export type RendererStylesheets = Readonly<Record<typeof STYLESHEETS[number], string>>;
/** Trusted composition binds this source to the compiler implementation it bundles, never to project-selected code/paths. */
export interface RendererSource {
  readonly version: string;
  readonly stylesheets: RendererStylesheets;
}
