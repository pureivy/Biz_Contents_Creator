/** webpack asset/resource 로 들어오는 폰트 — 번들이 emit 한 URL 문자열이 된다. */
declare module '*.woff2' {
  const url: string;
  export default url;
}
