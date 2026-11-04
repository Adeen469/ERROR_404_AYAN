// Asset-module type declarations, written locally on purpose.
// Vercel's per-function TypeScript transpilation cannot resolve the
// 'vite/client' type package, which failed every deployment with
// TS2688 ("Cannot find type definition file for 'vite/client'").
// These declarations give tsc everything this app actually imports
// (image files + the CSS side-effect import in main.tsx). All
// import.meta uses in src are explicitly cast, so nothing else
// from vite/client is needed.
declare module '*.css' {
  const content: string;
  export default content;
}
declare module '*.jpg' {
  const src: string;
  export default src;
}
declare module '*.jpeg' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*.gif' {
  const src: string;
  export default src;
}
declare module '*.webp' {
  const src: string;
  export default src;
}
declare module '*.svg' {
  const src: string;
  export default src;
}
