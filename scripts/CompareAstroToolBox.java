// Run against the unmodified AstroToolBox 4.6.1 JAR; no network query.
import astro.tool.box.spherex.SpherexPipeline;
import java.nio.file.*;
import java.lang.reflect.*;
import java.util.*;
import nom.tam.fits.*;

public class CompareAstroToolBox {
    public static void main(String[] args) throws Exception {
        Path cache = Path.of(args[0]), output = Path.of(args[1]);
        var config = new SpherexPipeline.Config(133.7599588, -7.2449993, 120, 2, true,
                cache.resolve("J133.7599588-7.2449993"), cache);
        Method measure = SpherexPipeline.class.getDeclaredMethod("measure", Path.class,
                SpherexPipeline.Config.class, Map.class, Map.class);
        measure.setAccessible(true);
        Map<Object,Object> areas = new HashMap<>(), channels = new HashMap<>();
        List<SpherexPipeline.Point> points = new ArrayList<>();
        Method world = SpherexPipeline.class.getDeclaredMethod("worldToPixel", Header.class, double.class, double.class);
        world.setAccessible(true);
        List<String> rows = new ArrayList<>(List.of("file,wavelength,flux,error,detector,x,y"));
        try (var paths = Files.list(config.cacheDir().resolve("cutouts"))) {
            for (Path path : paths.filter(p -> p.toString().endsWith(".fits")).sorted().toList()) {
                var p = (SpherexPipeline.Point) measure.invoke(null, path, config, areas, channels);
                if (p != null) {
                    points.add(p);
                    try (Fits fits = new Fits(path.toFile())) {
                        Header header = Arrays.stream(fits.read()).filter(h -> "IMAGE".equals(h.getHeader().getStringValue("EXTNAME"))).findFirst().orElseThrow().getHeader();
                        double[] xy = (double[]) world.invoke(null, header, config.raDeg(), config.decDeg());
                        rows.add(path.getFileName()+","+p.wavelengthUm()+","+p.fluxUjy()+","+p.errorUjy()+","+p.detector()+","+xy[0]+","+xy[1]);
                    }
                }
            }
        }
        Files.write(output.resolve("astrotoolbox-raw.csv"), rows);
        Method reject = SpherexPipeline.class.getDeclaredMethod("removeOutliersPerDetector", List.class, int.class, double.class, Set.class);
        reject.setAccessible(true);
        @SuppressWarnings("unchecked")
        var filtered = (List<SpherexPipeline.Point>) reject.invoke(null, points, 8, 3., Set.of(1,2,3,4,5,6));
        Method bin = SpherexPipeline.class.getDeclaredMethod("bin", List.class, Map.class);
        bin.setAccessible(true);
        @SuppressWarnings("unchecked")
        var binned = (List<SpherexPipeline.Point>) bin.invoke(null, filtered, channels);
        rows = new ArrayList<>(List.of("wavelength,flux,error,detector,count"));
        for (var p : binned.stream().sorted(Comparator.comparingDouble(SpherexPipeline.Point::wavelengthUm)).toList())
            rows.add(p.wavelengthUm()+","+p.fluxUjy()+","+p.errorUjy()+","+p.detector()+","+p.count());
        Files.write(output.resolve("astrotoolbox-binned.csv"), rows);
        System.out.println("AstroToolBox raw="+points.size()+" after rejection="+filtered.size()+" binned="+binned.size());
    }
}
