// 纯类型适配：`elements/markdown-text.tsx` 以副作用导入这份样式表，包内没有它的类型声明，
// 本仓的 TS 选项下副作用导入也要能解析到模块。
declare module "@assistant-ui/react-markdown/styles/dot.css";
