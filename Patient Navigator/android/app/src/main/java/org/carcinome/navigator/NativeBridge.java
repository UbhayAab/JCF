package org.carcinome.navigator;

import android.webkit.JavascriptInterface;
import android.widget.Toast;
import android.content.Context;

/**
 * JavaScript bridge — lets the web portal call native Android functions.
 * Usage from JS: CarcinomeNative.showToast("Hello")
 */
public class NativeBridge {

    private final Context context;

    public NativeBridge(Context context) {
        this.context = context;
    }

    @JavascriptInterface
    public void showToast(String message) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show();
    }

    @JavascriptInterface
    public boolean isNativeApp() {
        return true;
    }

    @JavascriptInterface
    public String getAppVersion() {
        return "1.0.0";
    }

    @JavascriptInterface
    public boolean isRecordingEnabled() {
        // Check if we have RECORD_AUDIO permission
        return context.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                == android.content.pm.PackageManager.PERMISSION_GRANTED;
    }
}
