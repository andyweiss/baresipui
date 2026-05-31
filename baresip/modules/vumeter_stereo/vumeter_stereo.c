/**
 * @file vumeter_stereo.c  Stereo VU-meter audio filter module
 *
 * Reports per-channel (L/R) audio levels in dBFS for both TX and RX
 * directions via baresip bevent system (BEVENT_VU_TX / BEVENT_VU_RX).
 *
 * This is a standalone module that does NOT modify baresip core.
 * It uses the public aufilt API and bevent API.
 *
 * Output: Standard VU_TX_REPORT / VU_RX_REPORT events with JSON param:
 *   {"l":-18.2,"r":-17.8}
 *
 * Events fire every ~100ms for smooth meter updates.
 */

#include <string.h>
#include <math.h>
#include <re.h>
#include <rem.h>
#include <baresip.h>


/** Update interval in milliseconds */
#define VU_INTERVAL_MS  100

/** Minimum dB value (silence floor) */
#define VU_DB_MIN  -96.0


/*
 * Call tracker: maps audio objects to their call for bevent emission
 */
struct vu_call {
	struct le le;
	struct call *call;
	const struct audio *au;
};

static struct list vu_calls = LIST_INIT;


static void vu_call_destructor(void *arg)
{
	struct vu_call *vc = arg;
	list_unlink(&vc->le);
}


static struct call *find_call_for_audio(const struct audio *au)
{
	struct le *le;

	for (le = vu_calls.head; le; le = le->next) {
		struct vu_call *vc = le->data;
		if (vc->au == au)
			return vc->call;
	}

	return NULL;
}


/*
 * Encode (TX) filter state
 */
struct vumeter_enc {
	struct aufilt_enc_st af;  /* inheritance */
	struct tmr tmr;
	const struct audio *au;
	double sum_l;
	double sum_r;
	uint32_t samples;
	volatile bool started;
};


/*
 * Decode (RX) filter state
 */
struct vumeter_dec {
	struct aufilt_dec_st af;  /* inheritance */
	struct tmr tmr;
	const struct audio *au;
	double sum_l;
	double sum_r;
	uint32_t samples;
	volatile bool started;
};


static void enc_destructor(void *arg)
{
	struct vumeter_enc *st = arg;
	list_unlink(&st->af.le);
	tmr_cancel(&st->tmr);
}


static void dec_destructor(void *arg)
{
	struct vumeter_dec *st = arg;
	list_unlink(&st->af.le);
	tmr_cancel(&st->tmr);
}


/**
 * Convert linear RMS sum to dBFS
 */
static double calc_dbfs(double sum, uint32_t n)
{
	double rms;

	if (n == 0)
		return VU_DB_MIN;

	rms = sqrt(sum / (double)n);

	if (rms < 1.0e-10)
		return VU_DB_MIN;

	/* For s16 samples, full scale = 32768 */
	return 20.0 * log10(rms / 32768.0);
}


/**
 * Timer handler for TX (encode) direction
 */
static void enc_tmr_handler(void *arg)
{
	struct vumeter_enc *st = arg;
	struct call *call;

	tmr_start(&st->tmr, VU_INTERVAL_MS, enc_tmr_handler, st);

	if (!st->started)
		return;

	call = find_call_for_audio(st->au);
	if (!call)
		return;

	double db_l = calc_dbfs(st->sum_l, st->samples);
	double db_r = calc_dbfs(st->sum_r, st->samples);

	bevent_call_emit(BEVENT_VU_TX, call,
			 "{\"l\":%.1f,\"r\":%.1f}", db_l, db_r);

	/* Reset accumulators */
	st->sum_l = 0.0;
	st->sum_r = 0.0;
	st->samples = 0;
}


/**
 * Timer handler for RX (decode) direction
 */
static void dec_tmr_handler(void *arg)
{
	struct vumeter_dec *st = arg;
	struct call *call;

	tmr_start(&st->tmr, VU_INTERVAL_MS, dec_tmr_handler, st);

	if (!st->started)
		return;

	call = find_call_for_audio(st->au);
	if (!call)
		return;

	double db_l = calc_dbfs(st->sum_l, st->samples);
	double db_r = calc_dbfs(st->sum_r, st->samples);

	bevent_call_emit(BEVENT_VU_RX, call,
			 "{\"l\":%.1f,\"r\":%.1f}", db_l, db_r);

	/* Reset accumulators */
	st->sum_l = 0.0;
	st->sum_r = 0.0;
	st->samples = 0;
}


/*
 * Accumulate per-channel RMS from interleaved samples
 */
static void accumulate_samples(double *sum_l, double *sum_r,
			       uint32_t *sample_count,
			       const int16_t *sampv, size_t sampc,
			       uint8_t ch)
{
	size_t i;

	if (ch >= 2) {
		/* Stereo: even indices = L, odd = R */
		for (i = 0; i + 1 < sampc; i += 2) {
			double sl = (double)sampv[i];
			double sr = (double)sampv[i + 1];
			*sum_l += sl * sl;
			*sum_r += sr * sr;
		}
		*sample_count += (uint32_t)(sampc / 2);
	}
	else {
		/* Mono: duplicate to both channels */
		for (i = 0; i < sampc; i++) {
			double s = (double)sampv[i];
			*sum_l += s * s;
			*sum_r += s * s;
		}
		*sample_count += (uint32_t)sampc;
	}
}


/*
 * Audio filter: encode update (TX direction — microphone)
 */
static int encode_update(struct aufilt_enc_st **stp, void **ctx,
			 const struct aufilt *af, struct aufilt_prm *prm,
			 const struct audio *au)
{
	struct vumeter_enc *st;
	(void)ctx;
	(void)prm;

	if (!stp || !af || !prm)
		return EINVAL;

	if (*stp)
		return 0;

	st = mem_zalloc(sizeof(*st), enc_destructor);
	if (!st)
		return ENOMEM;

	st->au = au;
	tmr_start(&st->tmr, VU_INTERVAL_MS, enc_tmr_handler, st);

	*stp = (struct aufilt_enc_st *)st;

	return 0;
}


/*
 * Audio filter: decode update (RX direction — speaker)
 */
static int decode_update(struct aufilt_dec_st **stp, void **ctx,
			 const struct aufilt *af, struct aufilt_prm *prm,
			 const struct audio *au)
{
	struct vumeter_dec *st;
	(void)ctx;
	(void)prm;

	if (!stp || !af || !prm)
		return EINVAL;

	if (*stp)
		return 0;

	st = mem_zalloc(sizeof(*st), dec_destructor);
	if (!st)
		return ENOMEM;

	st->au = au;
	tmr_start(&st->tmr, VU_INTERVAL_MS, dec_tmr_handler, st);

	*stp = (struct aufilt_dec_st *)st;

	return 0;
}


static int encode(struct aufilt_enc_st *st, struct auframe *af)
{
	struct vumeter_enc *vu = (void *)st;

	if (!st || !af)
		return EINVAL;

	accumulate_samples(&vu->sum_l, &vu->sum_r, &vu->samples,
			   af->sampv, af->sampc, af->ch);
	vu->started = true;

	return 0;
}


static int decode(struct aufilt_dec_st *st, struct auframe *af)
{
	struct vumeter_dec *vu = (void *)st;

	if (!st || !af)
		return EINVAL;

	accumulate_samples(&vu->sum_l, &vu->sum_r, &vu->samples,
			   af->sampv, af->sampc, af->ch);
	vu->started = true;

	return 0;
}


/*
 * Bevent handler: track call↔audio mappings
 */
static void event_handler(enum bevent_ev ev, struct bevent *event, void *arg)
{
	struct call *call = bevent_get_call(event);
	struct vu_call *vc;
	struct le *le;
	(void)arg;

	switch (ev) {

	case BEVENT_CALL_ESTABLISHED:
		if (!call)
			break;

		/* Check if already tracked */
		for (le = vu_calls.head; le; le = le->next) {
			vc = le->data;
			if (vc->call == call)
				return;
		}

		vc = mem_zalloc(sizeof(*vc), vu_call_destructor);
		if (!vc)
			return;

		vc->call = call;
		vc->au = call_audio(call);
		list_append(&vu_calls, &vc->le, vc);
		info("vumeter_stereo: tracking call %s\n", call_id(call));
		break;

	case BEVENT_CALL_CLOSED:
		if (!call)
			break;

		for (le = vu_calls.head; le; le = le->next) {
			vc = le->data;
			if (vc->call == call) {
				info("vumeter_stereo: untracking call\n");
				mem_deref(vc);
				break;
			}
		}
		break;

	default:
		break;
	}
}


static struct aufilt vumeter_stereo = {
	.name    = "vumeter_stereo",
	.encupdh = encode_update,
	.ench    = encode,
	.decupdh = decode_update,
	.dech    = decode,
};


static int module_init(void)
{
	aufilt_register(baresip_aufiltl(), &vumeter_stereo);
	bevent_register(event_handler, NULL);

	info("vumeter_stereo: module loaded (interval=%dms)\n",
	     VU_INTERVAL_MS);
	return 0;
}


static int module_close(void)
{
	struct le *le;

	bevent_unregister(event_handler);
	aufilt_unregister(&vumeter_stereo);

	/* Clean up call trackers */
	le = vu_calls.head;
	while (le) {
		struct vu_call *vc = le->data;
		le = le->next;
		mem_deref(vc);
	}

	info("vumeter_stereo: module unloaded\n");
	return 0;
}


EXPORT_SYM const struct mod_export DECL_EXPORTS(vumeter_stereo) = {
	"vumeter_stereo",
	"filter",
	module_init,
	module_close
};
