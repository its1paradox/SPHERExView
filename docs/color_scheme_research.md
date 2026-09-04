# Color rendering for SPHERExView: preserving faint red-source detectability and stable color meaning

## Executive conclusion

The present SPHERExView renderer is doing the one operation most likely to turn a faint red source into pastel noise: it independently standardizes the short- and long-wavelength images to their own local sky noise and then lets both channels contribute full-strength chroma. Near the detection limit, each channel therefore contains order-unity, largely independent color fluctuations. A real D6 signal is forced to compete visually with equally amplified D4 noise, while crop-to-crop or epoch-to-epoch changes in the estimated background and noise change the effective color gains.

The recommended default is:

1. **Subtract backgrounds per band, but do not independently normalize every displayed cutout to unit noise.**
2. **Convert to common calibrated flux-density or surface-brightness units, PSF-match, and apply fixed gains that remain unchanged through the blink.**
3. **Use one Lupton-style asinh intensity transform for the whole RGB triplet, not one nonlinear transform per band.**
4. **Keep the wavelength language fixed:** shorter wavelength is blue/cyan; longer wavelength is red plus half-strength green, hence orange. A long-only source is exactly proportional to \((R,G,B)=(1,0.5,0)\), while a short-only source is \((0,0.5,1)\).
5. **Suppress color below reliable joint S/N:** show low-S/N structure as neutral grayscale and turn on chroma smoothly between joint S/N 2 and 5.
6. For D6 hunting, offer three modes: **D4-blue/D6-orange** as the scientifically interpretable default; **grayscale reference plus an orange D6-excess overlay** as the strongest finder mode; and **monochrome D6** as the least ambiguous detection diagnostic.

The best starting display parameters are a common normalized asinh

\[
T(I)=\frac{\operatorname{asinh}(Q I/W)}{\operatorname{asinh}(Q)}
\]

with \(Q=10\), a frozen white point \(W=30\sigma_I\), a zero black point after background subtraction, chroma activated from S/N 2 to 5, and a high-S/N saturation factor of 1.25. This gives an asinh transition scale \(W/Q=3\sigma_I\). A context-oriented preset can use \(W=50\sigma_I\), \(Q=10\), giving a softer \(5\sigma_I\) transition and more bright-source headroom.

## 1. What the existing WISE systems actually do

### 1.1 Three products that should not be conflated

“unWISE color image” can refer to three different display pipelines:

| Product | Input | Purpose | Relevant color pipeline |
|---|---|---|---|
| WiseView | unWISE epoch/full-depth cutouts | Interactive blinking and difference imaging | WiseView’s own per-band display transform |
| Backyard Worlds time-resolved flipbooks | Four time-resolved unWISE epoch coadds, converted to difference images | Make moving sources conspicuous | Fixed sigma clipping, spatial high-pass filtering, per-band asinh, W1/W2 false color |
| Legacy Survey/unWISE viewer | W1 and W2 coadds or residual products | Static survey context | A color-preserving, common-intensity asinh recipe |

The underlying unWISE coaddition papers define how the astronomical images are resampled and combined; they do not, by themselves, define a unique RGB display. The RGB choices below come from the display implementations and the Backyard Worlds methods paper.

### 1.2 Current WiseView: documented behavior and auditable code

WiseView’s current help text says that W2 is assigned to red, W1 to blue, and green to their average; single-band W1 or W2 is displayed in grayscale ([WiseView help source](https://github.com/backyardworlds/wiseview/blob/21b3ec5b166b603ada8947ff59e24bd47004f314/wv/www/templates/flash3.html#L238-L268)). Therefore, for already stretched W1 and W2 planes \(u_1,u_2\),

\[
(R,G,B)=\left(u_2,\frac{u_1+u_2}{2},u_1\right).
\]

This is why “W2-red” is perceived as **orange**, not pure red:

- W2-only: \((1,0.5,0)\), HSV hue \(30^\circ\);
- W1-only: \((0,0.5,1)\), HSV hue \(210^\circ\);
- equal W1 and W2: \((1,1,1)\), neutral white/gray.

WiseView documents an `astropy.visualization.AsinhStretch`, with the UI’s **Linear** control setting Astropy’s \(a\) parameter and **Trim Bright** selecting the upper bound either as a percentile or as an absolute value; “adapt” estimates bounds automatically ([WiseView help source](https://github.com/backyardworlds/wiseview/blob/21b3ec5b166b603ada8947ff59e24bd47004f314/wv/www/templates/flash3.html#L263-L268)). Astropy’s exact normalized transform is

\[
y=\frac{\operatorname{asinh}(x/a)}{\operatorname{asinh}(1/a)},\qquad x\in[0,1],
\]

where \(a\) is the normalized transition between linear and logarithmic behavior ([Astropy `AsinhStretch` documentation](https://docs.astropy.org/en/stable/api/astropy.visualization.AsinhStretch.html)).

The public WiseView helper applies the following operation to **one array at a time** ([WiseView `image_parsing.py`](https://github.com/backyardworlds/wiseview/blob/21b3ec5b166b603ada8947ff59e24bd47004f314/wv/common/image_parsing.py#L96-L118)):

1. Choose \((l,h)\):
   - adapt: `shrink(arr)`;
   - percent: \(l=\max(\min F,-250)\), \(h=P_p(F)\);
   - fixed: \(l=\max(\min F,-250)\), \(h=\text{TrimBright}\).
2. Rescale that array from \([l,h]\) to \([0,1]\).
3. Apply `AsinhStretch(a)`.
4. Rescale the result again to \([0,1]\).

Because that helper receives and rescales each plane separately, it is **not** a Lupton common-intensity transform and does not preserve the original W2/W1 flux ratio. Percentile and adapt modes can make the relative color gain depend on the cutout.

There is an important reproducibility limitation. The repository’s present image-generation path calls a deployed service whose source is not included, so the current production service’s complete background handling cannot be audited from the public repository. The latest public pre-service renderer, at commit `7698cf184b77b5813b02617665f4beede5690a5a`, did explicitly add

\[
W2' = W2+\operatorname{median}(W1)-\operatorname{median}(W2)
\]

before stretching each band independently ([archived WiseView renderer](https://github.com/backyardworlds/wiseview/blob/7698cf184b77b5813b02617665f4beede5690a5a/unoverse.py#L183-L204)). That is **additive median background matching**, not shared multiplicative scaling. The archived code also assigned W1 to array channel 0 and W2 to channel 2, the reverse of the present help text; this historical implementation should therefore not be treated as proof of the current RGB order. The defensible current statement is: the UI promises W1-blue/W2-red and per-plane Astropy asinh controls, while exact production-service internals are not public.

### 1.3 Backyard Worlds time-resolved unWISE flipbooks: exact published recipe

Kuchner et al. constructed four displayed difference images from four epoch coadds:

\[
\begin{aligned}
D_1&=E_1-\operatorname{median}(E_3,E_4),\\
D_2&=E_2-\operatorname{median}(E_3,E_4),\\
D_3&=E_3-\operatorname{median}(E_1,E_2),\\
D_4&=E_4-\operatorname{median}(E_1,E_2).
\end{aligned}
\]

For each band they then:

1. clipped each difference image to \([-0.5\sigma,9.5\sigma]\);
2. used fixed representative noise values \(\sigma_{W1}=2.1\) and \(\sigma_{W2}=6.9\) Vega nanomaggies;
3. made a smoothed copy with a \(12\times12\) top-hat kernel and subtracted it to remove smoothly varying Galactic background and some electronic noise;
4. replaced each filtered difference plane by \(\operatorname{asinh}(10\,D)\);
5. assigned W1 to blue, W2 to red, and their mean to green.

Those details, including every number and equation, are in the original project paper ([Kuchner et al. 2017, ApJL 841 L19](https://ar5iv.labs.arxiv.org/html/1705.02919); [journal DOI](https://iopscience.iop.org/article/10.3847/2041-8213/aa7200)). The paper says the resulting maxima correspond roughly to point-source peaks at W1 = 16.3 mag and W2 = 15.0 mag.

This is not a single shared raw-flux scale: W1 and W2 use different band-specific sigma bounds. But it is more stable than per-cutout z-scoring because the published sigma values and clipping limits are fixed, and the background-removal kernel is explicit. The paper does **not** document an additional cross-band median match like the archived WiseView renderer.

### 1.4 How a cold brown dwarf appears

For WISE Vega magnitudes,

\[
\frac{F_\nu(W2)}{F_\nu(W1)}
=\frac{F_{\nu,0}(W2)}{F_{\nu,0}(W1)}\,10^{0.4(W1-W2)}.
\]

The official WISE zero-magnitude flux densities are 306.682 Jy in W1 and 170.663 Jy in W2 ([WISE Explanatory Supplement](https://irsa.ipac.caltech.edu/data/WISE/docs/release/All-Sky/expsup/sec2_3f.html)). Thus:

- \(W1-W2=5.00\) implies \(F_\nu(W2)/F_\nu(W1)=55.65\);
- the recent measurement \(W1-W2=5.36\pm0.40\) for WISE 0855−0714 implies a nominal ratio of 77.53 ([Wright et al., “Flux and Color of WISE 0855−0714”](https://arxiv.org/html/2505.12105v2)).

In the W1-blue/W2-red-plus-half-green language, such a source approaches \((1,0.5,0)\): a vivid orange point source. In a difference-image blink it can also have a negative residual at its old position, so the exact negative-lobe color depends on clipping or inversion. The positive current-position residual is the orange detection cue; later Backyard Worlds work explicitly describes redder/colder moving objects as appearing “distinctively orange” in this W1-blue/W2-red encoding ([Meisner et al. 2020 preprint](https://arxiv.org/pdf/2008.06396v1)).

## 2. Why common-intensity asinh is better for color detection

### 2.1 The Lupton et al. construction

Lupton et al. point out that applying a nonlinear function independently,

\[
R=f(r),\quad G=f(g),\quad B=f(b),
\]

changes color with brightness. Their prescription first forms an intensity

\[
I=\frac{r+g+b}{3},
\]

then applies one nonlinear function to that intensity and scales all three channels by the same multiplier:

\[
(R,G,B)=
\begin{cases}
(0,0,0), & I=0,\\[3pt]
\dfrac{f(I)}{I}(r,g,b), & I\ne0.
\end{cases}
\]

If \(\max(R,G,B)>1\), all three values are divided by that same maximum rather than independently clipped. The common multiplier preserves the ratios \(r:g:b\), so hue is independent of brightness until unavoidable gamut saturation. Their recommended family is

\[
f(I)=\frac{\operatorname{asinh}\!\left[\alpha Q(I-m)\right]}{Q},
\]

where \(m\) is the black point, \(\alpha\) controls the linear stretch, and \(Q\) controls the transition to logarithmic compression; the intensity reaching unit display value is

\[
M=m+\frac{\sinh Q}{\alpha Q}.
\]

These formulas and the shared-maximum saturation rule are from the primary paper ([Lupton et al. 2004, PASP 116, 133](https://arxiv.org/abs/astro-ph/0312483)).

For two scientific channels, use the same WISE-like triplet before calculating intensity:

\[
r=X_L,\qquad g=\frac{X_L+X_S}{2},\qquad b=X_S.
\]

Then \(I=(r+g+b)/3=(X_L+X_S)/2\). The display is therefore a two-band Lupton composite, not three independent measurements.

### 2.2 Exact Legacy Survey/unWISE recipes

The Legacy Survey viewer contains an explicit W1/W2 implementation with defaults `scale1=1`, `scale2=1`, `arcsinh=1/20`, `mn=-20`, `mx=10000`, and `w1weight=9` ([Legacy viewer `_unwise_to_rgb`](https://github.com/legacysurvey/imagine/blob/876587eed43f5c0b09c656d1e8091987a477d4a2/map/views.py#L6373-L6422)). Its nonlinear map is

\[
n(x)=\frac{\operatorname{asinh}(x/20)}{\sqrt{1/20}},
\]

and its brightness plane is

\[
I=n\!\left(\frac{9X_{W1}+X_{W2}}{10}\right).
\]

It then sets

\[
\mu=\max\!\left(10^{-6},\frac{|X_{W1}|+|X_{W2}|}{2}\right),
\quad
X'_{Wi}=\frac{|X_{Wi}|}{\mu}I,
\]

maps the transformed `mn` and `mx` to 0 and 1, clips, and assigns W1 to blue, W2 to red, and their mean to green. The absolute values are a pragmatic guard against pathological hues when one input is negative. The 9:1 W1 weighting is a **brightness-detection choice**, while color still comes from the W1/W2 ratio.

The legacypipe coadd writer contains an older related recipe: divide both W1 and W2 by 50, set `mn=-1`, `mx=100`, use \(n(x)=\operatorname{asinh}(x)\), transform the mean \((W1+W2)/2\), multiply each original plane by \(n(I)/I\), then map W1 to blue and W2 to red with mean green ([legacypipe `_unwise_to_rgb`](https://github.com/legacysurvey/legacypipe/blob/699f331f4ff222c34ea08a6846815f629f1b6d65/py/legacypipe/coadds.py#L321-L350)). This is closer to the canonical Lupton shared-intensity construction.

The optical Legacy Survey recipe likewise uses a common intensity, with defaults \(m=0.03\), \(Q=20\), and

\[
f(I)=\frac{\operatorname{asinh}(QI)}{\sqrt Q},
\]

while applying fixed band gains such as \(g:6.0\), \(r:3.4\), \(i:3.0\), and \(z/Y:2.2\) ([legacypipe `sdss_rgb`](https://github.com/legacysurvey/legacypipe/blob/699f331f4ff222c34ea08a6846815f629f1b6d65/py/legacypipe/survey.py#L492-L562)). This illustrates the important separation between **fixed scientific color gains** and **one shared nonlinear intensity stretch**.

### 2.3 Why independent noise equalization produces pastel mottling

Let the background-subtracted short and long measurements be

\[
F_S=s_S+n_S,\qquad F_L=s_L+n_L
\]

with sky standard deviations \(\sigma_S,\sigma_L\). The current normalization forms

\[
Z_S=\frac{F_S-\widehat b_S}{\widehat\sigma_S},\qquad
Z_L=\frac{F_L-\widehat b_L}{\widehat\sigma_L}.
\]

For blank sky, both displayed planes now have variance near one regardless of their physical sensitivity. Therefore every noise fluctuation has enough chroma leverage to move a pixel between blue/cyan and orange. A genuine source with \(Z_L=3\) and negligible true short-band flux is visually mixed with a short-band noise term of standard deviation one; its apparent WISE-like color ratio is unstable pixel by pixel. If \(\widehat\sigma\), percentiles, or extrema are re-estimated for every epoch, the band gain itself also changes through the blink.

This is a display-statistics failure, not evidence that D6 lacks information. Lupton et al.’s prerequisite is that inputs be background-subtracted and “appropriately scaled” before the common transform; independent nonlinear mapping is precisely the failure mode their method was designed to avoid ([Lupton et al. 2004](https://arxiv.org/abs/astro-ph/0312483)).

The remedies are complementary:

- **Background matching:** subtract an additive robust sky model in each detector, preferably a source-masked plane or coarse mesh. Match residual medians to zero. Do not use a multiplicative per-cutout z-score as the color calibration.
- **Fixed gains:** convert inputs to the same \(F_\nu\) or surface-brightness units and use gains set once for the product. Equal gains make an AB-flat \(F_\nu\) source neutral; alternatively derive a stellar-locus gain from many bright unsaturated stars and freeze it.
- **Common nonlinear stretch:** derive one \(T(I)/I\) multiplier and apply it to every RGB component.
- **Hue-preserving saturation:** when a channel would exceed gamut, rescale the entire RGB vector, as Lupton prescribes, rather than clipping channels separately.
- **S/N-gated chroma:** allow intensity to reveal low-S/N structure, but do not claim a color until the joint detection is strong enough.
- **Freeze display limits over time:** estimate white point and gains from all valid epochs or a reference calibration set, then reuse them for every frame.
- **PSF-match first:** differing PSFs otherwise create colored cores and halos even for a spectrally neutral point source.

## 3. Stable color semantics when the available bands change

There are two possible policies:

1. **Channel-role semantics:** “first selected image is red, second is green/blue.” A physical band can change hue when the selected subset or order changes.
2. **Wavelength-anchored semantics:** each detector or wavelength group keeps a fixed hue, and missing bands remain missing or the view switches explicitly to grayscale.

### What existing viewers do

- **WiseView:** not an arbitrary band compositor. W1 is blue and W2 red in W1+W2 mode; W1-only and W2-only are grayscale. Its semantics are therefore fixed by physical band, not selection order ([WiseView help](https://github.com/backyardworlds/wiseview/blob/21b3ec5b166b603ada8947ff59e24bd47004f314/wv/www/templates/flash3.html#L238-L268)).
- **Legacy Survey:** optical bands have persistent output-plane assignments—e.g. \(g\rightarrow B\), \(r\rightarrow G\), \(i,z,Y\rightarrow R\)—and gains are keyed by band name. Subsets do not automatically promote the reddest remaining band into a new role ([legacypipe band map](https://github.com/legacysurvey/legacypipe/blob/699f331f4ff222c34ea08a6846815f629f1b6d65/py/legacypipe/survey.py#L492-L530)). Its unWISE function is even stricter: it asserts the ordered pair `[1,2]` before assigning W1 blue and W2 red ([Legacy viewer source](https://github.com/legacysurvey/imagine/blob/876587eed43f5c0b09c656d1e8091987a477d4a2/map/views.py#L6373-L6420)).
- **Aladin desktop:** the RGB tool is positional—first image red, second green, third blue. With two planes it computes the missing plane as their mean, with green missing by default; when wavelength metadata are known, Aladin can sort planes by wavelength before assignment. Each channel has its own cuts/histogram, and Shift can synchronize cuts ([Aladin Desktop manual](https://aladin.cds.unistra.fr/java/AladinManualV10.pdf)). Its script command is likewise `RGB redPlane greenPlane bluePlane` ([Aladin script manual](https://aladin.cds.unistra.fr/java/AladinScriptManual.gml)). Thus Aladin offers flexible channel-role composition, but consistent physical semantics depend on ordering/metadata and synchronized cuts.

For a scientific blink finder, wavelength-anchored semantics are safer. A source must not change from orange to blue merely because a band group was omitted. SPHERExView should therefore reserve:

- D1–D4 aggregate or D4: blue/cyan role;
- D5–D6 aggregate or D6: orange role;
- single-band views: explicitly labeled grayscale;
- overlays: explicitly labeled orange “D6” or “D6 excess,” never silently reinterpreted RGB.

This is also spectrally sensible: SPHEREx D4 covers 2.42–3.82 µm and D6 covers 4.42–5.00 µm, bracketing the WISE W1/W2 color concept, although the bandpasses are not identical ([official SPHEREx instrument description](https://spherex.caltech.edu/page/instrument)).

## 4. Recommended SPHERExView recipes

### 4.1 Shared preprocessing for every recipe

For each detector image \(F_j\):

1. Apply masks and reject non-finite, saturated, persistence-affected, or otherwise invalid pixels.
2. Convert to a common calibrated unit, preferably \(F_\nu\) per pixel or surface brightness.
3. Match every input to a common PSF.
4. Estimate an additive source-masked background \(b_j(x,y)\). A practical default is a robust plane or a 32–64-pixel mesh followed by smooth interpolation; use larger meshes if SPHEREx cutouts are small.
5. Form \(f_j=F_j-b_j\).
6. Estimate \(\sigma_j\) from source-masked residuals with

\[
\sigma_j=1.4826\,\operatorname{median}\!\left|f_j-\operatorname{median}(f_j)\right|.
\]

Use \(\sigma_j\) for significance and thresholding, **not** as an automatically changing color gain.

All gains, band weights, black/white points, and stretch parameters must be held fixed across every frame in one blink. For reproducible survey-scale colors, also hold them fixed across cutouts, or offer a clearly labeled “local contrast” mode that is not used for color classification.

### 4.2 Recipe A — all-band overview: D1–D4 blue, D5–D6 orange

Construct fixed-weight group images:

\[
X_S=g_S\frac{\sum_{j=1}^{4}w_jf_j}{\sum_{j=1}^{4}w_j},
\qquad
X_L=g_L\frac{\sum_{j=5}^{6}w_jf_j}{\sum_{j=5}^{6}w_j}.
\]

Recommended default:

- \(w_j=1\) after common-unit calibration and PSF matching;
- or use mission-wide reference inverse-variance weights, but freeze them by detector and never recompute them per epoch;
- \(g_S=g_L=1\) for AB-flat \(F_\nu\) neutrality;
- optionally estimate \(g_L/g_S\) from the median short/long ratio of a large sample of ordinary unsaturated stars, then freeze that single ratio.

Set

\[
r=\max(0,X_L),\quad
g=\frac{\max(0,X_L)+\max(0,X_S)}{2},\quad
b=\max(0,X_S),
\]

\[
I=\frac{r+g+b}{3}=\frac{\max(0,X_L)+\max(0,X_S)}{2}.
\]

Apply the common asinh multiplier

\[
k=\frac{T(I)}{\max(I,\epsilon)},\qquad (R,G,B)=k(r,g,b),
\]

then, where \(\max(R,G,B)>1\), divide all three by that maximum. This is the Lupton hue-preserving rule ([Lupton et al. 2004](https://arxiv.org/abs/astro-ph/0312483)).

**Default all-band preset**

- \(Q=10\);
- \(W=40\sigma_I\), where \(\sigma_I\) is measured once from blank-sky pixels in the fixed-gain intensity image;
- transition \(W/Q=4\sigma_I\);
- black point \(m=0\);
- fallback white point: the 99.9th percentile of positive \(I\) over all frames, constrained to \(30\sigma_I\le W\le50\sigma_I\);
- high-S/N saturation factor 1.15, because the broad D1–D4 aggregate spans a much wider spectral range than D5–D6 and should not be overinterpreted as a precise two-band color.

### 4.3 Recipe B1 — preferred D6 color mode: D4 blue, D6 orange

Use only the fixed, PSF-matched, background-subtracted D4 and D6 images:

\[
X_S=g_4f_4,\qquad X_L=g_6f_6.
\]

Keep D4 in the short/blue role and D6 in the long/orange role in every epoch. Do not relabel D4 or D6 when other detectors are absent. Use the same RGB and common-intensity equations as Recipe A.

Choose the gain ratio by a declared reference:

- **AB-flat default:** calibrated \(F_\nu\), \(g_4=g_6=1\);
- **stellar-neutral option:** if the median bright-star ratio is \(q_\star=\operatorname{median}(f_6/f_4)\), set \(g_6/g_4=1/q_\star\), measured from a large reference set and frozen.

**Default D6 finder preset**

- \(Q=10\);
- \(W=30\sigma_I\);
- transition \(W/Q=3\sigma_I\);
- black point \(m=0\);
- fallback white point: all-epoch positive-intensity percentile 99.7, constrained to \(25\sigma_I\le W\le40\sigma_I\);
- saturation factor 1.25 above joint S/N 5;
- chroma gate from joint S/N 2 to 5.

Define joint positive-source significance

\[
S=\sqrt{
\max(0,X_S/\sigma_S')^2+
\max(0,X_L/\sigma_L')^2},
\]

where \(\sigma_S'=g_4\sigma_4\) and \(\sigma_L'=g_6\sigma_6\). Define

\[
t=\operatorname{clip}\!\left(\frac{S-2}{3},0,1\right),
\qquad
w=t^2(3-2t).
\]

After the Lupton stretch, convert RGB to HSV and set

\[
S_{\rm HSV,out}=\min\!\left(1,\ 1.25\,w\,S_{\rm HSV,in}\right),
\]

leaving HSV value and hue unchanged. Blank sky and marginal detections become neutral rather than mottled; full orange/blue chroma appears smoothly by S/N 5.

This mode gives the closest SPHEREx analogue to WiseView’s W1-blue/W2-orange language. It is a **proxy**, not an exact WISE color: D4 is broad and reaches 3.82 µm, while D6 spans 4.42–5.00 µm ([SPHEREx instrument bands](https://spherex.caltech.edu/page/instrument)).

### 4.4 Recipe B2 — strongest finder mode: grayscale reference plus orange D6-excess overlay

This mode is recommended when the operational question is “where are D6-bright movers?” rather than “what is the two-band color of every pixel?”

Let \(k_\star\) be the expected D6/D4 flux ratio of the neutral reference population. Form a red-excess image

\[
E=f_6-k_\star f_4,
\]

with uncertainty, neglecting covariance,

\[
\sigma_E=\sqrt{\sigma_6^2+k_\star^2\sigma_4^2}.
\]

If resampling creates measurable covariance, include the term \(-2k_\star\operatorname{Cov}(f_6,f_4)\). Use

\[
z_E=E/\sigma_E,\qquad
t_E=\operatorname{clip}\!\left(\frac{z_E-2.5}{2.5},0,1\right),\qquad
\alpha=t_E^2(3-2t_E).
\]

Build a grayscale context image \(L_{\rm ref}\) from D4 or the fixed D1–D4 aggregate with \(Q=10,W=40\sigma\). Stretch the positive excess with \(Q=10,W_E=20\sigma_E\):

\[
O=T_E(\max(E,0)).
\]

Blend with the fixed orange \(\mathbf c_O=(1,0.5,0)\):

\[
\mathbf C=(1-\alpha)L_{\rm ref}(1,1,1)+\alpha\,O\,\mathbf c_O.
\]

The overlay begins only at \(2.5\sigma\) color excess and reaches full opacity at \(5\sigma\). It prevents unrelated D4 noise from painting the neighborhood blue, while preserving a conspicuous WiseView-like orange cue for a D6 excess. Provide a toggle between **D6 excess** and **D6 detection**; the latter uses \(z_6=f_6/\sigma_6\) in place of \(z_E\) and is more complete but less color-selective.

### 4.5 Recipe B3 — monochrome D6 diagnostic

For pure detectability, render D6 alone:

\[
L_6=
\frac{\operatorname{asinh}\!\left(10\,\max(f_6,0)/(30\sigma_6)\right)}
{\operatorname{asinh}(10)}.
\]

Use a black background for the primary view. An optional diagnostic preset may map \(-0.5\sigma_6\) to black before stretching so small negative residuals remain visible, echoing the \(-0.5\sigma\) lower clip used by Backyard Worlds ([Kuchner et al. 2017](https://ar5iv.labs.arxiv.org/html/1705.02919)). Monochrome D6 carries no color semantics, but it is the correct cross-check when a candidate’s apparent orange color might be caused by D4 noise.

## 5. Parameter table and controls

| Control | Detection default | Context default | Notes |
|---|---:|---:|---|
| Asinh convention | \(T(I)=\operatorname{asinh}(QI/W)/\operatorname{asinh}(Q)\) | same | Explicitly label this convention; “Q” is not numerically interchangeable with Astropy’s \(a\) |
| \(Q\) | 10 | 10 | Reasonable user range 5–20 |
| White point \(W\) | \(30\sigma_I\) | \(50\sigma_I\) | Corresponding softening \(W/Q=3\sigma_I\) or \(5\sigma_I\) |
| Black point | 0 after sky subtraction | 0 | Optional monochrome diagnostic: \(-0.5\sigma\) |
| Percentile fallback | 99.7th, all epochs pooled | 99.9th, all epochs pooled | Clamp to a fixed sigma range; never recompute frame by frame |
| Chroma onset/full | S/N 2 / S/N 5 | S/N 2.5 / S/N 6 | Smoothstep, not a hard edge |
| Saturation boost | 1.25 | 1.10–1.15 | Apply only after S/N gating; cap HSV saturation at 1 |
| D6-excess overlay | 2.5σ onset, 5σ full | 3σ onset, 6σ full | Orange \((1,0.5,0)\) |
| Background model | source-masked robust plane or 32–64 px mesh | same | Freeze algorithm and mask policy |
| Blink normalization | one set per sequence | one set per sequence | Survey-calibrated mode should use global product values |

The normalized \(Q,W\) form is convenient because the meanings are transparent: \(T(W)=1\) and the linear-to-log transition is near \(I=W/Q\). For \(Q=10,W=30\sigma_I\), \(T(1\sigma_I)=0.109\), \(T(2\sigma_I)=0.209\), \(T(3\sigma_I)=0.294\), \(T(5\sigma_I)=0.428\), and \(T(30\sigma_I)=1\). Low-significance intensity is visible, but the separate chroma gate keeps it neutral.

If the implementation instead exposes Astropy’s `AsinhStretch(a)`, normalize intensity by \(W\) first and use \(a\approx0.10\) for the same \(W/Q\) transition when \(Q=10\). Astropy defines \(a\) as a fraction of the normalized image and uses \(y=\operatorname{asinh}(x/a)/\operatorname{asinh}(1/a)\) ([Astropy documentation](https://docs.astropy.org/en/stable/api/astropy.visualization.AsinhStretch.html)).

## 6. Implementation order and acceptance tests

### Minimal implementation order

1. Replace per-channel/local z-score display gains with background subtraction plus fixed calibrated gains.
2. Freeze gains and limits across the complete epoch stack.
3. Add common-intensity Lupton asinh and shared gamut normalization.
4. Add the S/N-gated saturation rule.
5. Add D6-excess overlay and monochrome D6 modes.
6. Add a UI legend stating the actual mapping and gain reference, for example: `D4 → blue; D6 → orange; AB-flat neutral; Q=10; W=30σ; chroma 2–5σ`.

### Quantitative acceptance tests

- **Neutrality:** inject equal calibrated \(F_\nu\) point sources into D4 and D6. With AB-flat gains, their high-S/N RGB values should satisfy \(R=G=B\) to within one output quantization level away from saturation.
- **Hue invariance:** inject the same D6/D4 ratio at intensities from \(3\sigma\) to \(100\sigma\). Above the full-chroma threshold, hue should vary by less than \(2^\circ\), except where all channels are deliberately desaturated at white.
- **Blink invariance:** repeat an identical injected source over epochs with different sky noise. Its hue and peak display value should remain stable under fixed gains and limits; only its measured S/N and chroma confidence may change.
- **Noise neutrality:** on blank sky, at least 95% of pixels with joint S/N below 2 should have HSV saturation zero under the recommended gate.
- **Cold-source recovery:** inject D6-only or very high D6/D4 sources at D6 S/N 3, 5, and 10. They should be neutral-faint at S/N 3, clearly orange by S/N 5, and strongly orange at S/N 10, without a pastel halo.
- **PSF control:** inject a neutral point source after realistic detector PSFs. After PSF matching, radial hue variation should stay below the hue-invariance tolerance.
- **Subset semantics:** D4 must remain the blue-role measurement and D6 the orange-role measurement in every composite. D6 alone must be labeled grayscale, not silently remapped to blue or red.

## Bottom line

WiseView and the Backyard Worlds flipbooks establish the useful visual language—shorter W1 blue, longer W2 red plus mean green, so cold sources appear orange—but WiseView’s publicly auditable helper independently rescales channels and is not the ideal model for preserving faint-source color. The Legacy Survey’s shared-intensity treatment and Lupton et al.’s hue-preserving asinh construction provide the stronger mathematical basis.

For SPHERExView, **D4-blue/D6-orange with fixed calibrated gains, common-intensity asinh, frozen blink limits, and S/N-gated chroma** should be the default scientific color mode. The **orange D6-excess overlay** should be the aggressive finder mode, and **monochrome D6** should remain the final detection sanity check.
