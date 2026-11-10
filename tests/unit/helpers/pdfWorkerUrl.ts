// Stand-in for the worker URL that Vite produces in a real build. In Node pdf.js runs its worker
// on the main thread and loads it by import; this resolves next to pdf.js's legacy build.
export default new URL('../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
