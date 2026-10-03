import java.nio.file.Paths;
import studio.core.v1.model.StoryPack;
import studio.core.v1.utils.PackFormat;

/** Contrôle de bonne formation FS utilisé uniquement par les smoke tests. */
public final class StudioFsReadback {
    private StudioFsReadback() {}

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            System.err.println("usage: StudioFsReadback <dossier-du-pack-fs>");
            System.exit(64);
        }
        StoryPack pack = PackFormat.FS.getReader().read(Paths.get(args[0]));
        if (pack == null) {
            System.out.println("RESULT=READBACK_ERROR reader returned null");
            System.exit(2);
        }
        System.out.println("uuid=" + pack.getUuid());
        System.out.println("version=" + pack.getVersion());
        System.out.println("nightMode=" + pack.isNightModeAvailable());
        System.out.println("stageNodes=" + pack.getStageNodes().size());
        long actions = pack.getStageNodes().stream()
                .flatMap(node -> java.util.stream.Stream.of(
                        node.getOkTransition(), node.getHomeTransition()))
                .filter(java.util.Objects::nonNull)
                .map(transition -> transition.getActionNode())
                .distinct()
                .count();
        System.out.println("actionNodes=" + actions);
        System.out.println("RESULT=READBACK_OK");
    }
}
