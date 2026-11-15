// Metro 配置：pnpm monorepo 支持（watchFolders 含仓库根与共享包，
// nodeModulesPaths 让 @pinglc/core 的 TS 源码可被 Expo 转译消费）
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
