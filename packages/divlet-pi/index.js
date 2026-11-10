// The Pi extension is one adapter of the divlet package, and this package is only its Pi packaging: the manifest Pi reads
// (`pi.extensions`) plus a re-export of the adapter that ships in `divlet`. No code lives here, so the adapter cannot drift
// from the product it belongs to.
export { default } from 'divlet/pi';
