// What Expo uses when there is no config; written out because Jest's Babel
// transform does not fall back to it the way Metro does.
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
