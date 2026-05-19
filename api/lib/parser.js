const COURIER_PATTERNS = [
  { name: 'Delhivery',    slug: 'delhivery',    patterns: [/delhivery\.com.*[?&]wbn=([A-Z0-9]+)/i,        /delhivery\.com\/track.*?\/([A-Z0-9]{10,20})/i] },
  { name: 'BlueDart',     slug: 'bluedart',     patterns: [/bluedart\.com.*waybill=(\d+)/i,                /bluedart\.com\/tracking.*?(\d{10,12})/i] },
  { name: 'DTDC',         slug: 'dtdc',         patterns: [/dtdc\.com.*trackingno=([A-Z0-9]+)/i,           /dtdc\.com\/tracking.*?([A-Z]\d{8,12})/i] },
  { name: 'India Post',   slug: 'india-post',   patterns: [/indiapost\.gov\.in.*consignment_id=([A-Z0-9]+)/i, /indiapost\.gov\.in.*?([A-Z]{2}\d{9}IN)/i] },
  { name: 'Ecom Express', slug: 'ecom-express', patterns: [/ecomexpress\.in.*awb_number=(\d+)/i,           /ecomexpress\.in\/tracking\/(\d{10,14})/i] },
  { name: 'Xpressbees',   slug: 'xpressbees',   patterns: [/xpressbees\.com.*awb=(\d+)/i] },
  { name: 'Shiprocket',   slug: 'shiprocket',   patterns: [/shiprocket\.in.*awb=([A-Z0-9]+)/i,            /shiprocket\.in\/tracking\/([A-Z0-9]+)/i] },
  { name: 'FedEx',        slug: 'fedex',        patterns: [/fedex\.com.*tracknumbers=(\d+)/i,              /fedex\.com.*trackingNumber=(\d+)/i] },
  { name: 'DHL',          slug: 'dhl',          patterns: [/dhl\.com.*tracking-id=([A-Z0-9]+)/i] },
  { name: 'UPS',          slug: 'ups',          patterns: [/ups\.com.*tracknum=([A-Z0-9]+)/i,              /ups\.com\/track.*?([1Z][A-Z0-9]{15,21})/i] },
];

function parseTrackingLink(input) {
  if (!input) return { tracking_id: null, courier: null, courier_slug: null };
  const trimmed = input.trim();

  let parsedUrl = null;
  try { parsedUrl = new URL(trimmed); } catch (_) {
    return { tracking_id: trimmed, courier: null, courier_slug: null, needs_auto_detect: true };
  }

  for (const courier of COURIER_PATTERNS) {
    for (const pattern of courier.patterns) {
      const match = trimmed.match(pattern);
      if (match) return { tracking_id: match[1].toUpperCase(), courier: courier.name, courier_slug: courier.slug };
    }
  }

  // Unknown courier — try to pull ID from URL
  const allParams = [...parsedUrl.searchParams.values()];
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
  for (const candidate of [...allParams, ...pathParts]) {
    if (/^[A-Z0-9]{8,25}$/i.test(candidate)) {
      return { tracking_id: candidate.toUpperCase(), courier: null, courier_slug: null, needs_auto_detect: true };
    }
  }

  return { tracking_id: null, courier: null, courier_slug: null };
}

function detectCourierFromUrl(url) {
  if (/delhivery/i.test(url))  return 'Delhivery';
  if (/bluedart/i.test(url))   return 'BlueDart';
  if (/fedex/i.test(url))      return 'FedEx';
  if (/dtdc/i.test(url))       return 'DTDC';
  if (/indiapost/i.test(url))  return 'India Post';
  if (/ecomexpress/i.test(url)) return 'Ecom Express';
  if (/shiprocket/i.test(url)) return 'Shiprocket';
  if (/xpressbees/i.test(url)) return 'Xpressbees';
  if (/dhl/i.test(url))        return 'DHL';
  if (/ups\.com/i.test(url))   return 'UPS';
  try { return new URL(url).hostname.replace('www.', ''); } catch { return 'Unknown'; }
}

module.exports = { parseTrackingLink, detectCourierFromUrl };
