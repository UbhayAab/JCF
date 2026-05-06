package org.carcinome.navigator;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/**
 * Uploads call recordings to Supabase Storage.
 * Then creates a record in the call_recordings table.
 */
public class SupabaseUploader {

    private static final String TAG = "SupabaseUploader";

    // Supabase config — same as web portal
    private static final String SUPABASE_URL = "https://bcgsejdwqefcdaqxykde.supabase.co";
    private static final String SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJjZ3NlamR3cWVmY2RhcXh5a2RlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MDczNzUsImV4cCI6MjA5MzQ4MzM3NX0.JtTeQdOmKTxwPNb-Cm_uPUbruvQdBpWGahuMIx4g9iU";
    private static final String STORAGE_BUCKET = "call-recordings";

    private final Context context;
    private final OkHttpClient httpClient;
    private final ExecutorService executor;

    public interface UploadCallback {
        void onSuccess(String fileUrl);
        void onFailure(String error);
    }

    public SupabaseUploader(Context context) {
        this.context = context;
        this.httpClient = new OkHttpClient.Builder()
                .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .writeTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
                .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
                .build();
        this.executor = Executors.newSingleThreadExecutor();
    }

    /**
     * Upload a recording file to Supabase Storage in the background.
     */
    public void uploadRecording(File file, String phoneNumber, UploadCallback callback) {
        executor.execute(() -> {
            try {
                // 1. Upload file to Supabase Storage
                String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
                String safePh = phoneNumber != null ? phoneNumber.replaceAll("[^0-9]", "") : "unknown";
                String storagePath = "auto/" + timestamp + "_" + safePh + ".m4a";

                String uploadUrl = SUPABASE_URL + "/storage/v1/object/" + STORAGE_BUCKET + "/" + storagePath;

                RequestBody fileBody = RequestBody.create(
                        MediaType.parse("audio/mp4"),
                        file
                );

                Request uploadRequest = new Request.Builder()
                        .url(uploadUrl)
                        .post(fileBody)
                        .addHeader("Authorization", "Bearer " + SUPABASE_ANON_KEY)
                        .addHeader("apikey", SUPABASE_ANON_KEY)
                        .addHeader("Content-Type", "audio/mp4")
                        .addHeader("x-upsert", "true")
                        .build();

                Response uploadResponse = httpClient.newCall(uploadRequest).execute();

                if (!uploadResponse.isSuccessful()) {
                    String errorBody = uploadResponse.body() != null ? uploadResponse.body().string() : "Unknown error";
                    Log.e(TAG, "Upload failed: " + uploadResponse.code() + " — " + errorBody);
                    callback.onFailure("Upload failed: HTTP " + uploadResponse.code());
                    return;
                }

                String publicUrl = SUPABASE_URL + "/storage/v1/object/public/" + STORAGE_BUCKET + "/" + storagePath;
                Log.i(TAG, "✅ File uploaded: " + publicUrl);

                // 2. Try to match this recording to a patient by phone number
                if (phoneNumber != null && phoneNumber.length() >= 10) {
                    String cleanPhone = phoneNumber.replaceAll("[^0-9]", "");
                    if (cleanPhone.length() > 10) cleanPhone = cleanPhone.substring(cleanPhone.length() - 10);

                    // Insert into call_recordings table via REST API
                    String insertUrl = SUPABASE_URL + "/rest/v1/call_recordings";
                    String json = "{"
                            + "\"file_url\":\"" + publicUrl + "\","
                            + "\"file_name\":\"" + file.getName() + "\","
                            + "\"file_size_bytes\":" + file.length() + ","
                            + "\"duration_seconds\":0"
                            + "}";

                    Request insertRequest = new Request.Builder()
                            .url(insertUrl)
                            .post(RequestBody.create(MediaType.parse("application/json"), json))
                            .addHeader("Authorization", "Bearer " + SUPABASE_ANON_KEY)
                            .addHeader("apikey", SUPABASE_ANON_KEY)
                            .addHeader("Content-Type", "application/json")
                            .addHeader("Prefer", "return=representation")
                            .build();

                    Response insertResponse = httpClient.newCall(insertRequest).execute();
                    Log.i(TAG, "Recording DB insert: " + insertResponse.code());
                }

                callback.onSuccess(publicUrl);

            } catch (IOException e) {
                Log.e(TAG, "Upload error: " + e.getMessage());
                callback.onFailure(e.getMessage());
            }
        });
    }
}
