/**
 * Конфигурация Webpack для сборки расширения "Confluence Change Analyzer".
 *
 * Точки входа:
 *  - background — service worker (Manifest V3)
 *  - content    — content script, внедряемый в страницы Confluence
 *  - popup      — логика всплывающего окна
 *
 * Статические файлы (manifest.json, popup.html, иконки) копируются в dist/ как есть.
 * Важно: в MV3 запрещён eval, поэтому в dev-режиме используется source map без eval.
 */
const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const MiniCssExtractPlugin = require('mini-css-extract-plugin');

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';

  return {
    entry: {
      background: './src/background/background.js',
      content: './src/content/content.js',
      popup: './src/popup/popup.js',
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: '[name].js',
      // Отдельные части (например, exporter.js с библиотекой docx) грузятся из корня расширения
      chunkFilename: '[name].js',
      publicPath: '/',
      clean: true,
    },
    // eval-source-map не работает в MV3 (CSP), поэтому cheap-module-source-map
    devtool: isProd ? false : 'cheap-module-source-map',
    module: {
      rules: [
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use: 'babel-loader',
        },
        {
          test: /\.css$/,
          use: [MiniCssExtractPlugin.loader, 'css-loader'],
        },
      ],
    },
    plugins: [
      // CSS из popup.js и content.js извлекается в popup.css / content.css
      new MiniCssExtractPlugin({ filename: '[name].css' }),
      new CopyPlugin({
        patterns: [
          { from: 'src/manifest.json', to: 'manifest.json' },
          { from: 'src/popup/popup.html', to: 'popup.html' },
          { from: 'src/icons', to: 'icons', globOptions: { ignore: ['**/variants/**'] } },
          // Страница инструкции (открывается кнопкой «?» в popup)
          { from: 'src/help', to: '.' },
        ],
      }),
    ],
    resolve: {
      extensions: ['.js'],
    },
    performance: {
      // docx довольно тяжёлый — отключаем предупреждения о размере бандла
      hints: false,
    },
    watchOptions: {
      ignored: /node_modules/,
    },
  };
};
