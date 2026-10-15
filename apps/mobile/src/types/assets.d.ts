// Metro hands back an asset id for a required asset, to be resolved through
// expo-asset. Only text assets are declared: they are the only kind required
// from TypeScript.
declare module '*.txt' {
  const asset: number;
  export default asset;
}
