// jsdom 缺失、Radix 覆盖层基元（Dialog/Drawer，及后续 Menu/Popover 等）运行时会调用的平台 API。
// 用法：渲染 Radix 覆盖层基元的测试文件顶部 `import "./radix-platform.js";`。
// 只在缺失时补 no-op 实现、不覆盖已有实现；jsdom 已提供的指针事件构造器不在此补。

if (!("ResizeObserver" in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

const elementPrototype = Element.prototype;
elementPrototype.hasPointerCapture ??= () => false;
elementPrototype.setPointerCapture ??= () => {};
elementPrototype.releasePointerCapture ??= () => {};
elementPrototype.scrollIntoView ??= () => {};
