<template>
  <span class="gal-menu-frame" aria-hidden="true"></span>
</template>

<style scoped>
/* Keep the paper in the control's non-negative paint layers during press/fade transitions. */
.gal-menu-frame { position: absolute; inset: 1px 2px; z-index: 0; pointer-events: none; transform: skewX(var(--gal-menu-skew, -9deg)); border: 1.5px solid var(--gal-menu-outline, var(--dialogue-menu-outline)); border-radius: 2px; background: var(--dialogue-menu-bg); box-shadow: 3px 3px 0 var(--dialogue-menu-edge), 0 5px 9px var(--dialogue-menu-shadow); transition: border-color var(--dur-interaction) var(--ease-standard); }
.gal-menu-frame::before { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 4px; background: var(--gal-menu-outline, var(--dialogue-menu-outline)); transition: background-color var(--dur-interaction) var(--ease-standard); }
.gal-menu-frame::after { content: ''; position: absolute; top: 5px; right: 6px; width: 10px; height: 2px; background: var(--dialogue-menu-accent); }
</style>
