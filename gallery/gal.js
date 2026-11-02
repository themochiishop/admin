// ===== Mochii 图库：共用程式（图库管理 upload.html、前台 viewer.html） =====
// 图库用自己的 Firebase 项目 my-gallery；用 email + 密码登录（一律 mail@themochiishop.com）
//
// 资料：
//   albums/{albumId}  { name, vis: "staff" | "public"（以后加 "member"）, order, cover, createdAt, updatedAt }
//   photos/{photoId}  { album, order, caption, hidden, url, thumb, path, thumbPath, w, h, legacy, createdAt, updatedAt }
// 图片：Storage 的 p/{photoId}.jpg（大图，长边 1600）和 p/{photoId}_t.jpg（缩图，长边 400）
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyBCkb5eDLElnQZ8Pt3Ud5euOmdkCo4QxqM",
  authDomain: "my-gallery-43e8a.firebaseapp.com",
  projectId: "my-gallery-43e8a",
  storageBucket: "my-gallery-43e8a.firebasestorage.app",
  messagingSenderId: "616009345293",
  appId: "1:616009345293:web:a61335e41cd7158014a844",
};

// 名字叫 "gallery"，不会跟会员系统（控制台登录用的）冲突
export const gapp = initializeApp(firebaseConfig, "gallery");
export const gauth = getAuth(gapp);
export const gdb = getFirestore(gapp);
export const gst = getStorage(gapp);

export const GAL_EMAIL = "mail@themochiishop.com";
export const BIG = 1600, THUMB = 400;

export const VIS = {
  staff: { icon: "🔒", label: "只限后台", hint: "有「图库 › 查看前台」权限的管理员才看得到（直播用）" },
  public: { icon: "🌐", label: "公开", hint: "以后放在官网的公开相册页，任何人都看得到" },
};

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.id).localeCompare(String(b.id));

// 把图片缩到最长边 max 像素，转成 JPEG（照片方向自动转正）
export async function compress(file, max, quality = 0.85) {
  let src, w, h;
  try {
    src = await createImageBitmap(file, { imageOrientation: "from-image" });
    w = src.width; h = src.height;
  } catch (e) {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("看不懂这个图片格式"));
      img.src = URL.createObjectURL(file);
    });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";                 // 透明背景（PNG）填白色
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  if (src.close) src.close();
  const blob = await new Promise(r => c.toBlob(r, "image/jpeg", quality));
  if (!blob) throw new Error("压缩失败");
  return { blob, w: c.width, h: c.height };
}
