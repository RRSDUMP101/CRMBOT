// Existing screens use pixel font sizes. Keep their hierarchy and change text only.
module.exports = function uiTypeScale() {
  return {
    postcssPlugin: "rrs-ui-type-scale",
    Once(root) {
      root.walkDecls("font-size", declaration => {
        const size = /^(\d+(?:\.\d+)?)px$/.exec(declaration.value);
        if (size) declaration.value = `calc(${size[1]} * var(--crm-text-unit, 1px))`;
      });
    },
  };
};
module.exports.postcss = true;
