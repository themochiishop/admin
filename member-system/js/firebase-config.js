// member-system Firebase 配置（这段资料本来就会出现在网页中，可以公开）
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAdZkjbROHfmM_YSUeutoNpmXf5EHBwLlU",
  authDomain: "member-system-27ae0.firebaseapp.com",
  projectId: "member-system-27ae0",
  storageBucket: "member-system-27ae0.firebasestorage.app",
  messagingSenderId: "692900536052",
  appId: "1:692900536052:web:24e3d6ccbd038ba3f4c8a1"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
