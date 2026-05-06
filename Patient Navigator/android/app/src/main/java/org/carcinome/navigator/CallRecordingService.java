package org.carcinome.navigator;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Environment;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Foreground service that manages call recording.
 * Started/stopped by PhoneCallReceiver when call state changes.
 */
public class CallRecordingService extends Service {

    private static final String TAG = "CallRecordingService";
    private static final String CHANNEL_ID = "call_recording_channel";
    private static final int NOTIFICATION_ID = 1001;

    private MediaRecorder recorder;
    private String currentRecordingPath;
    private String currentPhoneNumber;
    private boolean isRecording = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String action = intent.getStringExtra("action");
            if ("START_RECORDING".equals(action)) {
                currentPhoneNumber = intent.getStringExtra("phone_number");
                startRecording();
            } else if ("STOP_RECORDING".equals(action)) {
                stopRecording();
            }
        }

        // Show persistent notification
        Notification notification = buildNotification(
                isRecording ? "🔴 Recording call..." : "Monitoring calls",
                isRecording ? "Recording in progress with " + (currentPhoneNumber != null ? currentPhoneNumber : "unknown")
                        : "Carcinome Navigator is ready to record calls"
        );
        startForeground(NOTIFICATION_ID, notification);

        return START_STICKY;
    }

    public void startRecording() {
        if (isRecording) return;

        try {
            // Create recordings directory
            File dir = new File(getExternalFilesDir(Environment.DIRECTORY_MUSIC), "call_recordings");
            if (!dir.exists()) dir.mkdirs();

            // Generate filename with timestamp and phone number
            String timestamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.getDefault()).format(new Date());
            String safePh = currentPhoneNumber != null ? currentPhoneNumber.replaceAll("[^0-9]", "") : "unknown";
            String filename = "call_" + timestamp + "_" + safePh + ".m4a";
            currentRecordingPath = new File(dir, filename).getAbsolutePath();

            recorder = new MediaRecorder();

            // Try VOICE_CALL first (records both sides), fallback to MIC
            try {
                recorder.setAudioSource(MediaRecorder.AudioSource.VOICE_CALL);
            } catch (Exception e) {
                Log.w(TAG, "VOICE_CALL source not available, falling back to MIC");
                recorder.reset();
                recorder = new MediaRecorder();
                recorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            }

            recorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            recorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            recorder.setAudioSamplingRate(44100);
            recorder.setAudioEncodingBitRate(128000);
            recorder.setOutputFile(currentRecordingPath);

            recorder.prepare();
            recorder.start();
            isRecording = true;

            Log.i(TAG, "✅ Recording started: " + currentRecordingPath);

            // Update notification
            updateNotification("🔴 Recording call...",
                    "Recording " + (currentPhoneNumber != null ? currentPhoneNumber : "unknown number"));

        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to start recording: " + e.getMessage());
            isRecording = false;
            cleanupRecorder();
        }
    }

    public void stopRecording() {
        if (!isRecording || recorder == null) return;

        try {
            recorder.stop();
            recorder.release();
            recorder = null;
            isRecording = false;

            Log.i(TAG, "✅ Recording stopped: " + currentRecordingPath);

            // Upload the recording to Supabase
            if (currentRecordingPath != null) {
                File recordingFile = new File(currentRecordingPath);
                if (recordingFile.exists() && recordingFile.length() > 0) {
                    Log.i(TAG, "📤 Uploading recording (" + recordingFile.length() / 1024 + " KB)...");
                    new SupabaseUploader(this).uploadRecording(
                            recordingFile,
                            currentPhoneNumber,
                            new SupabaseUploader.UploadCallback() {
                                @Override
                                public void onSuccess(String fileUrl) {
                                    Log.i(TAG, "✅ Upload success: " + fileUrl);
                                    updateNotification("✅ Call recorded & uploaded",
                                            "Recording saved to portal");
                                }

                                @Override
                                public void onFailure(String error) {
                                    Log.e(TAG, "❌ Upload failed: " + error);
                                    updateNotification("⚠️ Recording saved locally",
                                            "Upload failed — will retry later");
                                }
                            }
                    );
                }
            }

            // Reset notification
            updateNotification("Monitoring calls", "Ready to record next call");

        } catch (Exception e) {
            Log.e(TAG, "Error stopping recording: " + e.getMessage());
            cleanupRecorder();
        }
    }

    private void cleanupRecorder() {
        if (recorder != null) {
            try {
                recorder.release();
            } catch (Exception ignored) {}
            recorder = null;
        }
        isRecording = false;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Call Recording",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows when Carcinome Navigator is recording calls");
            channel.setShowBadge(false);

            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification(String title, String text) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, notificationIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(text)
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setContentIntent(pi)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .build();
    }

    private void updateNotification(String title, String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null) {
            nm.notify(NOTIFICATION_ID, buildNotification(title, text));
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        cleanupRecorder();
    }
}
