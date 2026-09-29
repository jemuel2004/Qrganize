/**
 * InstructorWorkloadFooter
 *
 * Generates the print-footer HTML and CSS for the NEMSU Instructor Workload form.
 * Exported as plain functions so they can be embedded in the document.write() print template.
 * Update FOOTER_CONFIG to change contact info or logo paths.
 */

export interface FooterConfig {
  address: string;
  phone:   string;
  website: string;
  logoOrigin: string;
}

export const DEFAULT_FOOTER_CONFIG: Omit<FooterConfig, 'logoOrigin'> = {
  address: 'Cantilan, Surigao del Sur 8317',
  phone:   '086-212-2723',
  website: 'www.nemsu.edu.ph',
};

/** Returns the <style> rules for the footer (injected once into <head>). */
export function footerCss(): string {
  return `
/* -- PRINT FOOTER -- */
.pf {
  position: fixed;
  bottom: 0.1in; left: 0; right: 0;
  border-top: 1px solid #555;
  background: #fff;
  padding: 5px 0.5in 4px;
}
.pf-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
/* Left — contact block */
.pf-contact {
  flex: 0 0 auto;
  font-family: Arial, sans-serif;
  font-size: 12px;
  font-weight: normal;
  line-height: 1.6;
  color: #111;
}
.pf-contact .pf-row {
  display: flex;
  align-items: center;
  gap: 5px;
}
.pf-contact a {
  color: #0000EE;
  text-decoration: underline;
}
/* Right — logos */
.pf-logos {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.pf-logos img {
  height: 55px;
  width: auto;
  object-fit: contain;
  display: block;
}
`;
}

/** Returns the footer <div> HTML string. */
export function footerHtml(cfg: FooterConfig): string {
  const { address, phone, website, logoOrigin } = cfg;
  return `
<div class="pf">
  <div class="pf-inner">

    <!-- Left: contact information -->
    <div class="pf-contact">
      <div class="pf-row"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="14" viewBox="0 0 24 30" fill="#111" style="flex-shrink:0;vertical-align:middle"><path d="M12 0C7.589 0 4 3.589 4 8c0 6.675 7.3 14.742 7.617 15.083a.5.5 0 0 0 .766 0C12.7 22.742 20 14.675 20 8c0-4.411-3.589-8-8-8zm0 12a4 4 0 1 1 0-8 4 4 0 0 1 0 8z"/></svg> ${address}</div>
      <div class="pf-row">&#9742; ${phone}</div>
      <div class="pf-row">&#127757; <a href="https://${website}" target="_blank">${website}</a></div>
    </div>

    <!-- Right: official logos -->
    <div class="pf-logos">
      <img src="${logoOrigin}/nemlogo/ISO-UKAS.png"              alt="ISO-UKAS">
      <img src="${logoOrigin}/nemlogo/BAGONG-PILIPINAS-LOGO.png" alt="Bagong Pilipinas">
    </div>

  </div>
</div>
`;
}
