#!/usr/bin/env node
// `npx create-nowaki-app` 向けの極薄エイリアス。import するだけで create-nowaki が argv を読んで実行される。
// create-nowaki@0.1.0 は main 未定義なので、明示パスで "index" 探索の DeprecationWarning を避ける。
import "create-nowaki/index.js";
