package org.carcinome.navigator;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.TelephonyManager;
import android.util.Log;

/**
 * Detects when phone calls start and end.
 * Triggers the CallRecordingService to start/stop recording.
 */
public class PhoneCallReceiver extends BroadcastReceiver {

    private static final String TAG = "PhoneCallReceiver";

    private static String lastState = TelephonyManager.EXTRA_STATE_IDLE;
    private static String savedNumber;
    private static boolean isIncoming = false;

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();

        if (action == null) return;

        // Outgoing call
        if (action.equals(Intent.ACTION_NEW_OUTGOING_CALL)) {
            savedNumber = intent.getStringExtra(Intent.EXTRA_PHONE_NUMBER);
            isIncoming = false;
            Log.i(TAG, "📞 Outgoing call to: " + savedNumber);
            return;
        }

        // Incoming call state changes
        if (action.equals(TelephonyManager.ACTION_PHONE_STATE_CHANGED)) {
            String stateStr = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
            if (stateStr == null) return;

            String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
            if (number != null) {
                savedNumber = number;
            }

            if (TelephonyManager.EXTRA_STATE_RINGING.equals(stateStr)) {
                    // Incoming call ringing
                    isIncoming = true;
                    Log.i(TAG, "📱 Incoming call from: " + savedNumber);

            } else if (TelephonyManager.EXTRA_STATE_OFFHOOK.equals(stateStr)) {
                    // Call answered (either incoming or outgoing)
                    if (lastState.equals(TelephonyManager.EXTRA_STATE_RINGING)) {
                        // Incoming call answered
                        Log.i(TAG, "✅ Incoming call answered: " + savedNumber);
                    } else if (lastState.equals(TelephonyManager.EXTRA_STATE_IDLE)) {
                        // Outgoing call started
                        Log.i(TAG, "✅ Outgoing call started: " + savedNumber);
                    }

                    // START RECORDING
                    Intent startIntent = new Intent(context, CallRecordingService.class);
                    startIntent.putExtra("action", "START_RECORDING");
                    startIntent.putExtra("phone_number", savedNumber);
                    context.startForegroundService(startIntent);

            } else if (TelephonyManager.EXTRA_STATE_IDLE.equals(stateStr)) {
                    // Call ended
                    if (!lastState.equals(TelephonyManager.EXTRA_STATE_IDLE)) {
                        Log.i(TAG, "📴 Call ended: " + savedNumber);

                        // STOP RECORDING
                        Intent stopIntent = new Intent(context, CallRecordingService.class);
                        stopIntent.putExtra("action", "STOP_RECORDING");
                        stopIntent.putExtra("phone_number", savedNumber);
                        context.startForegroundService(stopIntent);
                    }
            }

            lastState = stateStr;
        }
    }
}
