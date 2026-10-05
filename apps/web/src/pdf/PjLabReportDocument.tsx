import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { truncatePdfCell } from './pdfText.ts';

export interface PjLabReportItem {
  readonly no: number;
  readonly bulan: string;
  readonly dokterNama: string;
  readonly jumlahFormatted: string;
  readonly adminNama: string;
}

export interface PjLabReportData {
  readonly logoSrc: string;
  readonly tanggalCetak: string;
  readonly items: readonly PjLabReportItem[];
  readonly totalFormatted: string;
}

const BLUE = '#2b4c9b';
const BLACK = '#1a1a1a';

const styles = StyleSheet.create({
  page: {
    padding: 28,
    fontFamily: 'Helvetica',
    fontSize: 9,
    color: BLACK,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  logo: {
    width: 56,
    height: 56,
    marginRight: 12,
    objectFit: 'contain',
  },
  headerText: {
    flex: 1,
    alignItems: 'center',
  },
  clinicSmall: {
    fontSize: 9,
    letterSpacing: 1,
  },
  clinicName: {
    fontSize: 20,
    fontWeight: 'bold',
    color: BLUE,
    marginTop: 1,
  },
  clinicAddress: {
    fontSize: 8.5,
    marginTop: 3,
  },
  // Garis kop surat ganda: tebal lalu tipis.
  dividerThick: {
    height: 2.5,
    backgroundColor: BLACK,
    marginTop: 8,
  },
  dividerThin: {
    height: 0.8,
    backgroundColor: BLACK,
    marginTop: 1.5,
    marginBottom: 16,
  },
  title: {
    fontSize: 12,
    fontWeight: 'bold',
    textAlign: 'center',
    textTransform: 'uppercase',
    textDecoration: 'underline',
  },
  subtitle: {
    fontSize: 8.5,
    textAlign: 'center',
    marginTop: 3,
    marginBottom: 14,
  },
  table: {
    borderWidth: 0.8,
    borderColor: BLACK,
  },
  thRow: {
    flexDirection: 'row',
    backgroundColor: '#e2e8f0',
    borderBottomWidth: 0.8,
    borderColor: BLACK,
    fontWeight: 'bold',
  },
  trRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderColor: BLACK,
    minHeight: 42,
  },
  totalRow: {
    flexDirection: 'row',
    fontWeight: 'bold',
  },
  cell: {
    paddingVertical: 4,
    paddingHorizontal: 4,
    borderRightWidth: 0.5,
    borderColor: BLACK,
    justifyContent: 'center',
  },
  colNo: { width: '7%', textAlign: 'center' },
  colBulan: { width: '20%' },
  colDokter: { width: '30%' },
  colJumlah: { width: '18%', textAlign: 'right' },
  colTtd: { width: '25%', borderRightWidth: 0, justifyContent: 'flex-end', alignItems: 'center' },
  ttdName: {
    fontSize: 7.5,
    color: '#475569',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 24,
  },
  footerBox: {
    width: 170,
    alignItems: 'center',
  },
  footerTitle: {
    marginBottom: 40,
  },
  footerLine: {
    borderTopWidth: 0.8,
    borderColor: BLACK,
    width: '100%',
    paddingTop: 2,
    textAlign: 'center',
  },
});

export function PjLabReportDocument({ data }: { readonly data: PjLabReportData }) {
  return (
    <Document title="Laporan_PJ_Laboratorium.pdf">
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow}>
          {data.logoSrc ? <Image style={styles.logo} src={data.logoSrc} /> : null}
          <View style={styles.headerText}>
            <Text style={styles.clinicSmall}>KLINIK ROENTGEN, USG DAN LABORATORIUM</Text>
            <Text style={styles.clinicName}>PRIMA HUSADA</Text>
            <Text style={styles.clinicAddress}>
              Jl Siliwangi No 28 A Parung Kuda Telp. 0857-1932-5557
            </Text>
          </View>
          {/* Penyeimbang lebar logo supaya teks kop tepat di tengah halaman. */}
          {data.logoSrc ? <View style={{ width: 68 }} /> : null}
        </View>
        <View style={styles.dividerThick} />
        <View style={styles.dividerThin} />

        <Text style={styles.title}>Laporan PJ Laboratorium</Text>
        <Text style={styles.subtitle}>Tanggal cetak: {data.tanggalCetak}</Text>

        <View style={styles.table}>
          <View style={styles.thRow}>
            <Text style={[styles.cell, styles.colNo]}>No</Text>
            <Text style={[styles.cell, styles.colBulan]}>Bulan</Text>
            <Text style={[styles.cell, styles.colDokter]}>Nama Dokter</Text>
            <Text style={[styles.cell, styles.colJumlah]}>Jumlah</Text>
            <Text style={[styles.cell, styles.colTtd, { textAlign: 'center' }]}>TTD Admin</Text>
          </View>
          {data.items.length === 0 ? (
            <View style={styles.trRow}>
              <Text style={[styles.cell, { width: '100%', textAlign: 'center', borderRightWidth: 0 }]}>
                Belum ada data PJ.
              </Text>
            </View>
          ) : (
            data.items.map((row) => (
              <View key={row.no} style={styles.trRow} wrap={false}>
                <Text style={[styles.cell, styles.colNo]}>{row.no}</Text>
                <Text style={[styles.cell, styles.colBulan]}>{row.bulan}</Text>
                <Text style={[styles.cell, styles.colDokter]}>{truncatePdfCell(row.dokterNama, 34)}</Text>
                <Text style={[styles.cell, styles.colJumlah]}>{row.jumlahFormatted}</Text>
                {/* Kolom dibiarkan kosong untuk tanda tangan basah; nama admin di bawahnya. */}
                <View style={[styles.cell, styles.colTtd]}>
                  <Text style={styles.ttdName}>{row.adminNama ? `( ${row.adminNama} )` : ''}</Text>
                </View>
              </View>
            ))
          )}
          <View style={styles.totalRow}>
            <Text style={[styles.cell, { width: '57%', textAlign: 'right' }]}>Total</Text>
            <Text style={[styles.cell, styles.colJumlah]}>{data.totalFormatted}</Text>
            <Text style={[styles.cell, styles.colTtd]} />
          </View>
        </View>

        <View style={styles.footer} wrap={false}>
          <View style={styles.footerBox}>
            <Text style={styles.footerTitle}>Mengetahui,</Text>
            <Text style={styles.footerLine}>Klinik Prima Husada</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}
