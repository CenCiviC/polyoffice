"""서식 값을 정확히 아는 docx/odt 픽스처 생성 — 파서 회귀 테스트용.

넣는 것: A4 페이지·여백, 가운데 정렬, 스타일 상속으로 받은 14pt,
빨강 굵게, 기울임+밑줄, 열 병합(2), 행 병합(2), 셀 배경 #D9E2F3, 셀 폭,
하이퍼링크(외부·앵커), 위/아래첨자, 들여쓰기·내어쓰기·문단 앞뒤 여백.
"""
import zipfile, sys, os

OUT = sys.argv[1]

DOCX_CT = '''<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>'''

DOCX_RELS = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

# 하이퍼링크는 TargetMode="External" 관계로만 주소를 갖는다
DOCX_DOC_RELS = '''<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://www.mois.go.kr/manual" TargetMode="External"/>
</Relationships>'''

# Normal(색·글꼴) ← Body(14pt) 상속 체인을 만들어 basedOn 해석을 검증한다
DOCX_STYLES = '''<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/>
  <w:rPr><w:rFonts w:eastAsia="맑은 고딕"/><w:color w:val="1F2937"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Body"><w:name w:val="Body"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:jc w:val="center"/></w:pPr><w:rPr><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>'''

DOCX_DOC = '''<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>
  <w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>
    <w:r><w:t xml:space="preserve">상속받은 14pt 가운데</w:t></w:r></w:p>
  <w:p>
    <w:r><w:rPr><w:b/><w:color w:val="C00000"/><w:sz w:val="24"/></w:rPr>
      <w:t xml:space="preserve">빨간 굵게 12pt</w:t></w:r>
    <w:r><w:rPr><w:i/><w:u w:val="single"/></w:rPr>
      <w:t xml:space="preserve">기울임밑줄</w:t></w:r>
    <w:r><w:br/></w:r>
    <w:r><w:tab/><w:t xml:space="preserve">탭 뒤</w:t></w:r>
  </w:p>
  <w:p>
    <w:pPr><w:ind w:left="400" w:firstLine="260"/><w:spacing w:before="100" w:after="60"/></w:pPr>
    <w:hyperlink r:id="rId10"><w:r><w:t xml:space="preserve">링크된글자</w:t></w:r></w:hyperlink>
    <w:r><w:t xml:space="preserve">보통글자</w:t></w:r>
    <w:hyperlink w:anchor="b7"><w:r><w:t xml:space="preserve">앵커링크</w:t></w:r></w:hyperlink>
  </w:p>
  <w:p>
    <w:pPr><w:ind w:left="600" w:hanging="300"/></w:pPr>
    <w:r><w:t xml:space="preserve">면적 1,200m</w:t></w:r>
    <w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r>
    <w:r><w:t xml:space="preserve"> 와 H</w:t></w:r>
    <w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>2</w:t></w:r>
    <w:r><w:t xml:space="preserve">O</w:t></w:r>
  </w:p>
  <w:tbl>
    <w:tblGrid><w:gridCol w:w="2880"/><w:gridCol w:w="2880"/></w:tblGrid>
    <w:tr>
      <w:tc><w:tcPr><w:gridSpan w:val="2"/><w:shd w:fill="D9E2F3"/></w:tcPr>
        <w:p><w:r><w:t xml:space="preserve">두 칸 병합 머리글</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:tcW w:type="dxa" w:w="2880"/><w:vMerge w:val="restart"/></w:tcPr>
        <w:p><w:r><w:t xml:space="preserve">세로 병합</w:t></w:r></w:p></w:tc>
      <w:tc><w:tcPr><w:tcW w:type="dxa" w:w="2880"/></w:tcPr>
        <w:p><w:r><w:t xml:space="preserve">오른쪽 위</w:t></w:r></w:p></w:tc>
    </w:tr>
    <w:tr>
      <w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
      <w:tc><w:tcPr><w:tcW w:type="dxa" w:w="2880"/></w:tcPr>
        <w:p><w:r><w:t xml:space="preserve">오른쪽 아래</w:t></w:r></w:p></w:tc>
    </w:tr>
  </w:tbl>
  <w:sectPr>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1440" w:right="1080" w:bottom="1440" w:left="1080" w:header="720" w:footer="720"/>
  </w:sectPr>
</w:body>
</w:document>'''

ODT_STYLES = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0">
<office:styles>
  <style:default-style style:family="paragraph">
    <style:text-properties fo:font-size="10pt" fo:color="#1F2937"/></style:default-style>
  <style:style style:name="Normal" style:family="paragraph">
    <style:text-properties style:font-name="맑은 고딕"/></style:style>
</office:styles>
<office:automatic-styles>
  <style:page-layout style:name="pm1"><style:page-layout-properties
    fo:page-width="21cm" fo:page-height="29.7cm"
    fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="1.9cm" fo:margin-right="1.9cm"/>
  </style:page-layout>
</office:automatic-styles>
</office:document-styles>'''

ODT_CONTENT = '''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"
 xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"
 xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:xlink="http://www.w3.org/1999/xlink">
<office:automatic-styles>
  <style:style style:name="P1" style:family="paragraph" style:parent-style-name="Normal">
    <style:paragraph-properties fo:text-align="center"/>
    <style:text-properties fo:font-size="14pt"/></style:style>
  <style:style style:name="T1" style:family="text">
    <style:text-properties fo:font-weight="bold" fo:color="#C00000" fo:font-size="12pt"/></style:style>
  <style:style style:name="T2" style:family="text">
    <style:text-properties fo:font-style="italic" style:text-underline-style="solid"/></style:style>
  <style:style style:name="P2" style:family="paragraph" style:parent-style-name="Normal">
    <style:paragraph-properties fo:margin-left="20pt" fo:text-indent="13pt" fo:margin-top="5pt" fo:margin-bottom="3pt"/></style:style>
  <style:style style:name="P3" style:family="paragraph" style:parent-style-name="Normal">
    <style:paragraph-properties fo:margin-left="30pt" fo:text-indent="-15pt"/></style:style>
  <style:style style:name="T3" style:family="text">
    <style:text-properties style:text-position="super 58%"/></style:style>
  <style:style style:name="T4" style:family="text">
    <style:text-properties style:text-position="sub 58%"/></style:style>
  <style:style style:name="co1" style:family="table-column">
    <style:table-column-properties style:column-width="5.08cm"/></style:style>
  <style:style style:name="ce1" style:family="table-cell">
    <style:table-cell-properties fo:background-color="#D9E2F3" fo:padding="0.1cm"/></style:style>
</office:automatic-styles>
<office:body><office:text>
  <text:p text:style-name="P1">상속받은 14pt 가운데</text:p>
  <text:p text:style-name="Normal"><text:span text:style-name="T1">빨간 굵게 12pt</text:span><text:span text:style-name="T2">기울임밑줄</text:span><text:line-break/><text:tab/>탭 뒤</text:p>
  <text:p text:style-name="P2"><text:a xlink:href="https://www.mois.go.kr/manual">링크된글자</text:a>보통글자</text:p>
  <text:p text:style-name="P3">면적 1,200m<text:span text:style-name="T3">2</text:span> 와 H<text:span text:style-name="T4">2</text:span>O</text:p>
  <table:table table:name="T">
    <table:table-column table:style-name="co1" table:number-columns-repeated="2"/>
    <table:table-row>
      <table:table-cell table:style-name="ce1" table:number-columns-spanned="2">
        <text:p>두 칸 병합 머리글</text:p></table:table-cell>
      <table:covered-table-cell/>
    </table:table-row>
    <table:table-row>
      <table:table-cell table:number-rows-spanned="2"><text:p>세로 병합</text:p></table:table-cell>
      <table:table-cell><text:p>오른쪽 위</text:p></table:table-cell>
    </table:table-row>
    <table:table-row>
      <table:covered-table-cell/>
      <table:table-cell><text:p>오른쪽 아래</text:p></table:table-cell>
    </table:table-row>
  </table:table>
</office:text></office:body>
</office:document-content>'''

ODT_MANIFEST = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3">
<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>
<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>
<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>
</manifest:manifest>'''


def write(path, entries, stored_first=None):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        if stored_first:
            name, data = stored_first
            z.writestr(zipfile.ZipInfo(name), data, compress_type=zipfile.ZIP_STORED)
        for name, data in entries:
            z.writestr(name, data)


write(os.path.join(OUT, 'sample.docx'), [
    ('[Content_Types].xml', DOCX_CT),
    ('_rels/.rels', DOCX_RELS),
    ('word/document.xml', DOCX_DOC),
    ('word/styles.xml', DOCX_STYLES),
    ('word/_rels/document.xml.rels', DOCX_DOC_RELS),
])

write(os.path.join(OUT, 'sample.odt'), [
    ('META-INF/manifest.xml', ODT_MANIFEST),
    ('content.xml', ODT_CONTENT),
    ('styles.xml', ODT_STYLES),
], stored_first=('mimetype', 'application/vnd.oasis.opendocument.text'))

print('생성 완료:', os.listdir(OUT))
