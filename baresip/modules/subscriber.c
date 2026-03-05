// Assuming necessary includes and context are set

void close_handler(struct pres *pres, struct sip_msg *msg) {
    switch (msg->code) {
        case 404:
        case 481:
            pres->failc = 0; // Reset fail count for these codes
            pres->retry_wait = 30; // Fixed retry wait of 30 seconds
            break;
        default:
            pres->failc++; // Increment fail count for other status codes
            pres->retry_wait = wait_fail(++pres->failc); // Maintain existing behavior
            break;
    }
}