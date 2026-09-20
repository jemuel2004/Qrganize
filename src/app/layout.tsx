import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import FaviconUpdater from "@/client/components/ui/FaviconUpdater";

export const metadata: Metadata = {
  title: "QRganize — QR-Based Program Scheduler",
  description: "QR-powered room booking, instructor workload tracking, and program scheduling",
};

/** Runs before paint.
 *  Authenticated app themes stay in localStorage (per-role preference keys).
 *  Public auth pages (/login) always use the default Login appearance (light)
 *  and must NOT inherit authenticated Dark Mode preferences.
 *
 *  Admin/Dept Chair and Instructor share ONE visual system (`html.light`).
 *  Only which preference key is read differs by route.
 */
const THEME_BOOTSTRAP = `(function(){try{
  var path=location.pathname||'';
  var isLogin=path==='/login'||path.indexOf('/login/')===0;
  var html=document.documentElement;
  html.removeAttribute('data-instructor-theme');
  if(isLogin){
    html.classList.add('light');
    return;
  }
  var onInstructor=path.indexOf('/instructor')===0;
  if(onInstructor){
    var i=localStorage.getItem('instructor-theme');
    var r='light';
    if(i==='dark')r='dark';
    else if(i==='system')r=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
    else{r='light';if(!i)localStorage.setItem('instructor-theme','light');}
    if(r==='dark')html.classList.remove('light');
    else html.classList.add('light');
    return;
  }
  var a=localStorage.getItem('admin-theme');
  if(a==='dark'){html.classList.remove('light');}
  else{html.classList.add('light');if(!a)localStorage.setItem('admin-theme','light');}
}catch(e){document.documentElement.classList.add('light');}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-slate-100">
        {/*
          Theme bootstrap via next/script beforeInteractive — NOT a raw <head><script>.
          A raw head script was hydrating against Meta In-App Browser's injected
          iab-pcm-sdk (facebook.net/pcm.js), causing a server/client attribute mismatch.
        */}
        <Script id="qrganize-theme-bootstrap" strategy="beforeInteractive">
          {THEME_BOOTSTRAP}
        </Script>
        <FaviconUpdater />
        {children}
      </body>
    </html>
  );
}
