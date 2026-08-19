package in.chhaperia.erp;

import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.text.InputType;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

/**
 * The whole app: a WebView onto the ERP, plus the two things a WebView does
 * not give you for free — a way to say WHERE the server is, and somewhere for
 * downloaded invoices and labels to go.
 *
 * The server address is asked for rather than compiled in because the office
 * PC's LAN address changes with the network. Baking it into the APK would
 * mean a new APK every time that happened.
 */
public class MainActivity extends AppCompatActivity {

  private static final String PREFS = "chhaperia";
  private static final String KEY_SERVER = "server_url";

  private WebView web;
  private SwipeRefreshLayout refresh;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_main);

    refresh = findViewById(R.id.refresh);
    web = findViewById(R.id.web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);          // the ERP is a JS app; without this there is no app
    s.setDomStorageEnabled(true);          // localStorage: theme, collapsed nav, draft forms
    s.setDatabaseEnabled(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    s.setBuiltInZoomControls(true);
    s.setDisplayZoomControls(false);
    s.setMediaPlaybackRequiresUserGesture(false);
    /* The ERP sets its own viewport and has a responsive layout, so let the
       page decide its width rather than pretending to be a desktop. */
    s.setSupportZoom(true);

    CookieManager.getInstance().setAcceptCookie(true);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

    web.setWebChromeClient(new WebChromeClient());
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
        Uri u = req.getUrl();
        String host = u.getHost();
        String server = serverUrl();
        /* Anything on the ERP's own host stays in the app. A link to anywhere
           else — a supplier's site, a mailto: — belongs to the phone, not to
           this window. */
        if (server != null && host != null && host.equals(Uri.parse(server).getHost())) return false;
        try {
          startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (Exception e) {
          Toast.makeText(MainActivity.this, "Nothing on this device can open that link", Toast.LENGTH_SHORT).show();
        }
        return true;
      }

      @Override
      public void onPageFinished(WebView v, String url) {
        refresh.setRefreshing(false);
      }

      @Override
      public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
        if (!req.isForMainFrame()) return;
        refresh.setRefreshing(false);
        /* A failure here is nearly always "the office PC is off" or "this
           tablet is on the wrong Wi-Fi" — say so, and offer the one action
           that actually fixes the third case. */
        new AlertDialog.Builder(MainActivity.this)
          .setTitle("Can't reach the ERP")
          .setMessage("No answer from " + serverUrl() + ".\n\n"
            + "• Is this tablet on the factory Wi-Fi?\n"
            + "• Is the office PC that runs the ERP switched on?\n"
            + "• Has the server's address changed?")
          .setPositiveButton("Retry", (d, w) -> web.reload())
          .setNeutralButton("Change server", (d, w) -> askForServer(true))
          .setCancelable(false)
          .show();
      }
    });

    /* Invoices, labels and CSV exports are real files people need to keep. */
    web.setDownloadListener(new DownloadListener() {
      @Override
      public void onDownloadStart(String url, String userAgent, String disposition,
                                  String mimeType, long size) {
        try {
          if (url.startsWith("blob:") || url.startsWith("data:")) {
            Toast.makeText(MainActivity.this,
              "This file is generated in the page — use its Print button instead",
              Toast.LENGTH_LONG).show();
            return;
          }
          DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
          r.setMimeType(mimeType);
          r.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
          r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
          String name = android.webkit.URLUtil.guessFileName(url, disposition, mimeType);
          r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
          ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
          Toast.makeText(MainActivity.this, "Saving " + name + " to Downloads", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
          Toast.makeText(MainActivity.this, "Could not save that file", Toast.LENGTH_SHORT).show();
        }
      }
    });

    refresh.setOnRefreshListener(() -> web.reload());

    /* Back walks the app's own history first, and only leaves once there is
       none left — otherwise every stray tap closes the ERP. */
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        if (web.canGoBack()) web.goBack();
        else finish();
      }
    });

    String server = serverUrl();
    if (server == null) askForServer(false);
    else web.loadUrl(server);
  }

  private SharedPreferences prefs() {
    return getSharedPreferences(PREFS, MODE_PRIVATE);
  }

  private String serverUrl() {
    return prefs().getString(KEY_SERVER, null);
  }

  /** Ask where the ERP lives. `canCancel` is false on a first run — without
      an address there is nothing for the app to show. */
  private void askForServer(boolean canCancel) {
    final EditText input = new EditText(this);
    input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
    input.setHint("192.168.1.4:4000");
    String cur = serverUrl();
    if (cur != null) input.setText(cur);

    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    int pad = (int) (20 * getResources().getDisplayMetrics().density);
    box.setPadding(pad, pad / 2, pad, 0);
    box.addView(input);

    AlertDialog.Builder b = new AlertDialog.Builder(this)
      .setTitle("Where is the ERP?")
      .setMessage("Type the address of the office PC running the ERP. "
        + "Ask the office if you are not sure.")
      .setView(box)
      .setCancelable(canCancel)
      .setPositiveButton("Connect", (d, w) -> {
        String v = normalise(input.getText().toString());
        if (v == null) {
          Toast.makeText(this, "That does not look like an address", Toast.LENGTH_SHORT).show();
          askForServer(canCancel);
          return;
        }
        prefs().edit().putString(KEY_SERVER, v).apply();
        web.loadUrl(v);
      });
    if (canCancel) b.setNegativeButton("Cancel", null);
    b.show();
  }

  /** Accepts "192.168.1.4:4000", "erp.local", or a full URL, and returns
      something a WebView can actually load — or null if it is hopeless.
      This is also where the cleartext rule is enforced: the network security
      config cannot express "private addresses only" (it has no idea what a
      CIDR range is), but this can. */
  static String normalise(String raw) {
    if (raw == null) return null;
    String v = raw.trim();
    if (v.isEmpty()) return null;
    if (!v.matches("(?i)^https?://.*")) v = (isPrivateHost(hostOf("http://" + v)) ? "http://" : "https://") + v;
    Uri u = Uri.parse(v);
    String host = u.getHost();
    if (host == null || host.isEmpty()) return null;
    /* Plain HTTP is for the factory's own network. An address out on the
       public internet must be HTTPS — otherwise this company's stock and
       payroll would cross it in the clear because somebody mistyped. */
    if ("http".equalsIgnoreCase(u.getScheme()) && !isPrivateHost(host)) return null;
    /* A bare host with no port means the ERP's own port, not port 80 —
       nobody on the floor is going to type ":4000" reliably. */
    if (u.getPort() == -1 && "http".equalsIgnoreCase(u.getScheme())) v = v.replaceAll("/+$", "") + ":4000";
    return v;
  }

  private static String hostOf(String url) {
    try { return Uri.parse(url).getHost(); } catch (Exception e) { return null; }
  }

  /** True for loopback, the RFC1918 ranges, link-local, and .local names —
      i.e. everything that can only be reached from inside the building. */
  static boolean isPrivateHost(String host) {
    if (host == null) return false;
    String h = host.toLowerCase();
    if (h.equals("localhost") || h.endsWith(".local") || h.endsWith(".lan")) return true;
    String[] p = h.split("\\.");
    if (p.length != 4) return false;
    int[] o = new int[4];
    for (int i = 0; i < 4; i++) {
      try { o[i] = Integer.parseInt(p[i]); } catch (NumberFormatException e) { return false; }
      if (o[i] < 0 || o[i] > 255) return false;
    }
    if (o[0] == 127 || o[0] == 10) return true;                    // loopback, 10/8
    if (o[0] == 192 && o[1] == 168) return true;                   // 192.168/16
    if (o[0] == 172 && o[1] >= 16 && o[1] <= 31) return true;      // 172.16/12
    if (o[0] == 169 && o[1] == 254) return true;                   // link-local
    return false;
  }

  /* There is deliberately no options menu. The theme has no action bar — the
     ERP draws its own header, and a native title bar on top of it would just
     be a second one saying the same thing — so a menu would have nowhere to
     appear from. The two ways the server address actually needs changing are
     both covered: the first launch asks for it, and any failure to reach it
     offers "Change server" right in the error. Pull down to reload. */

  @Override
  protected void onDestroy() {
    if (web != null) { web.destroy(); web = null; }
    super.onDestroy();
  }

  /** Keeps the login cookie across a swipe-away. */
  @Override
  protected void onPause() {
    super.onPause();
    CookieManager.getInstance().flush();
  }
}
