import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Optional;
import studio.core.v1.model.StoryPack;
import studio.core.v1.utils.PackAssetsCompression;
import studio.core.v1.utils.PackFormat;
import studio.core.v1.writer.fs.FsStoryPackWriter;

/** Harnais headless : ZIP STUdio -> StoryPack -> pack FS. */
public final class StudioFsConvert {
    private StudioFsConvert() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("usage: StudioFsConvert <pack.zip> <dossier-de-sortie>");
            System.exit(64);
        }

        Path zip = Paths.get(args[0]);
        if (!Files.isRegularFile(zip)) {
            System.out.println("RESULT=ERREUR_LECTURE fichier ZIP absent ou non regulier: " + zip);
            System.exit(2);
        }
        Path outDir = Files.createDirectories(Paths.get(args[1]));

        long t0 = System.currentTimeMillis();
        StoryPack pack;
        try {
            pack = PackFormat.ARCHIVE.getReader().read(zip);
        } catch (Exception error) {
            System.out.println("RESULT=ERREUR_LECTURE " + describe(error));
            System.exit(2);
            return;
        }
        if (pack == null) {
            // ArchiveStoryPackReader renvoie null, sans exception, lorsque story.json
            // n'est pas à la racine du ZIP.
            System.out.println("RESULT=ERREUR_LECTURE story.json absent a la racine du ZIP");
            System.exit(2);
            return;
        }
        long t1 = System.currentTimeMillis();

        Path packFolder;
        long t2;
        long t3;
        try {
            PackAssetsCompression.processFirmware2dot4(pack);
            t2 = System.currentTimeMillis();
            packFolder = FsStoryPackWriter.createPackFolder(pack, outDir);
            PackFormat.FS.getWriter().write(pack, packFolder, true, Optional.empty());
            t3 = System.currentTimeMillis();
        } catch (Exception error) {
            System.out.println("RESULT=ERREUR_CONVERSION " + describe(error));
            System.exit(3);
            return;
        }

        System.out.println("uuid=" + pack.getUuid());
        System.out.println("version=" + pack.getVersion());
        System.out.println("nightMode=" + pack.isNightModeAvailable());
        System.out.println("stageNodes=" + pack.getStageNodes().size());
        long distinctActions = pack.getStageNodes().stream()
                .flatMap(node -> java.util.stream.Stream.of(
                        node.getOkTransition(), node.getHomeTransition()))
                .filter(java.util.Objects::nonNull)
                .map(transition -> transition.getActionNode())
                .distinct()
                .count();
        System.out.println("actionNodes=" + distinctActions);
        System.out.println("packFolder=" + packFolder.toAbsolutePath().normalize());
        System.out.println("msRead=" + (t1 - t0)
                + " msAssets=" + (t2 - t1)
                + " msWrite=" + (t3 - t2));

        int missing = 0;
        for (String filename : new String[] {"ni", "li", "ri", "si"}) {
            Path path = packFolder.resolve(filename);
            boolean present = Files.isRegularFile(path);
            if (!present) {
                missing++;
            }
            System.out.println("file " + filename + " present=" + present
                    + " size=" + (present ? Files.size(path) : -1));
        }
        for (String dirname : new String[] {"rf", "sf"}) {
            Path path = packFolder.resolve(dirname);
            boolean present = Files.isDirectory(path);
            // Sans image (`ri` vide), STUdio n'écrit pas `rf` : l'absence est normale.
            boolean optional = dirname.equals("rf")
                    && Files.isRegularFile(packFolder.resolve("ri"))
                    && Files.size(packFolder.resolve("ri")) == 0;
            if (!present && !optional) {
                missing++;
            }
            long count = present
                    ? Files.walk(path).filter(Files::isRegularFile).count()
                    : -1;
            System.out.println("dir " + dirname + " present=" + present + " files=" + count);
        }
        System.out.println("bt present=" + Files.isRegularFile(packFolder.resolve("bt")));
        System.out.println("nm present=" + Files.isRegularFile(packFolder.resolve("nm")));

        if (missing == 0) {
            System.out.println("RESULT=OK");
        } else {
            System.out.println("RESULT=INCOMPLETE missing=" + missing);
            System.exit(4);
        }
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        return error.getClass().getName() + ": " + (message == null ? "" : message);
    }
}
