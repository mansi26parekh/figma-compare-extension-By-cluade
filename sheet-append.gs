/**
 * Bind to your Google Sheet: Extensions → Apps Script → paste this file → Deploy → Web app
 * (Execute as: Me, access: Anyone or Anyone with Google account).
 *
 * Extension `background.js`:
 * - GOOGLE_SHEET_WEBAPP_URL (+ optional secret) — required for appending rows. Highlight image uploads here too
 *   (action upload_image → Drive) unless CLOUDINARY_* is set; then links point to Cloudinary instead.
 *
 * Script property WEBAPP_SECRET must match GOOGLE_SHEET_WEBAPP_SECRET if you set it.
 *
 * POST JSON:
 * - { "action": "upload_image", "screenshotBase64": "...", "imageMimeType": "image/jpeg", "secret": "..." }
 *   → { "ok": true, "url": "https://drive.google.com/..." }  (optional fallback)
 * - { "rows": [{ "id", "description", "screenshot": "https://...", "status" }], "secret": "..." }
 *   → Column C is a clickable "Issue #N – open highlight" link (HYPERLINK) when URL is present, so devs see which row the image belongs to.
 */
function formatIssuesSheet_(sheet) {
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 56);
  sheet.setColumnWidth(2, 520);
  sheet.setColumnWidth(3, 220);
  sheet.setColumnWidth(4, 160);
  var lr = sheet.getLastRow();
  if (lr >= 2) {
    sheet.getRange(2, 2, lr, 2).setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);
    sheet.getRange(2, 2, lr, 2).setVerticalAlignment("top");
  }
  sheet.getRange("B1").setNote("Issue details from QA. Text wraps; widen column B if needed.");
  sheet.getRange("C1").setNote(
    "Click the cell to open the highlight image for this issue (same ID as column A).",
  );
  sheet.getRange("D1").setNote(
    "Review status: extension defaults to \"need to fix\". Devs update to fixed, in progress, wontfix, pass, etc.",
  );
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var body = JSON.parse(e.postData && e.postData.contents ? e.postData.contents : "{}");
    var expected = PropertiesService.getScriptProperties().getProperty("WEBAPP_SECRET") || "";
    if (expected && String(body.secret || "") !== expected) {
      return jsonOut({ ok: false, error: "unauthorized" });
    }

    if (body.action === "upload_image") {
      if (!body.screenshotBase64) {
        return jsonOut({ ok: false, error: "screenshotBase64 required" });
      }
      var mime = body.imageMimeType || "image/png";
      var ext = /jpe?g/i.test(String(mime)) ? "jpg" : "png";
      var blob = Utilities.newBlob(
        Utilities.base64Decode(body.screenshotBase64),
        mime,
        "figma-qa-highlight." + ext,
      );
      var file = DriveApp.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      var id = file.getId();
      var viewUrl = "https://drive.google.com/file/d/" + id + "/view?usp=sharing";
      return jsonOut({ ok: true, url: viewUrl });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) {
      return jsonOut({ ok: false, error: "Bind this script to your Sheet (Extensions → Apps Script from the spreadsheet)." });
    }

    var sheet = ss.getSheetByName("Issues");
    if (!sheet) {
      sheet = ss.insertSheet("Issues");
    }
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(["ID", "issue description", "Issue link (screenshot)", "review status"]);
    }

    var shotUrl = "";
    if (body.screenshotBase64) {
      var smime = body.screenshotMimeType || "image/png";
      var sext = /jpe?g/i.test(String(smime)) ? "jpg" : "png";
      var sblob = Utilities.newBlob(
        Utilities.base64Decode(body.screenshotBase64),
        smime,
        "figma-qa." + sext,
      );
      var sfile = DriveApp.createFile(sblob);
      sfile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      shotUrl = "https://drive.google.com/file/d/" + sfile.getId() + "/view?usp=sharing";
    }

    var rows = body.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      // Only use the per-row screenshot URL (cropped problem area). Never fall back to a single full-page image.
      // If a row has no screenshot URL, keep the cell empty/placeholder instead of showing an unrelated overview.
      var shotRaw = row.screenshot || row.screenshotUrl || "";
      var sTrim = String(shotRaw).trim();
      var shotCell = sTrim;
      // Clickable label so devs see which issue the image is for (matches column A).
      if (/^https?:\/\//i.test(sTrim)) {
        var escUrl = sTrim.replace(/"/g, '""');
        var linkLabel = String(row.id) + " – open highlight";
        var escLab = linkLabel.replace(/"/g, '""');
        shotCell = '=HYPERLINK("' + escUrl + '","' + escLab + '")';
      } else if (!sTrim) {
        shotCell = "—";
      }
      // Review column is always this label (extension CSV matches).
      sheet.appendRow([row.id, row.description, shotCell, "need to fix"]);
    }

    formatIssuesSheet_(sheet);

    return jsonOut({ ok: true, appended: rows.length });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
