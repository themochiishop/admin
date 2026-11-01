// 白色 / 暗黑模式：在 <head> 最先执行，避免页面先闪一下白色
// 记在这台设备（localStorage）；没选过就跟着系统设定
(function () {
  var t = null;
  try { t = localStorage.getItem("msAdminTheme"); } catch (e) {}
  if (t !== "dark" && t !== "light") {
    t = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  document.documentElement.setAttribute("data-theme", t);
})();
