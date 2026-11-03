import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A video file the Damaged Files job has read to the end, because it takes up
 * less disk than its size says (see server/lib/damagedFiles.ts). The stored
 * result saves reading it again while the file stays the same.
 */
@Entity()
class ScannedFile {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', unique: true })
  public path: string;

  /** Size and modified time when it was read. */
  @Column({ type: 'varchar' })
  public fingerprint: string;

  @Column({ type: 'boolean', default: false })
  @Index()
  public damaged: boolean;

  @Column({ type: 'int', default: 0 })
  public zeroPercent: number;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public firstSeenAt: Date;

  constructor(init?: Partial<ScannedFile>) {
    Object.assign(this, init);
  }
}

export default ScannedFile;
